import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { installFlowUiFixture } from './helpers/flowUiFixture.mjs'

// 回归：设置页标题栏必须 sticky 固定在窗口顶部 56px（与 chat-topbar 同模式）——
// 内容只在其下方滚动，顶部常驻拖拽区（::before，避开右侧窗口控制区），窗口控制按钮始终最前。
const output = resolve('.temp/settings-titlebar-ui')
await mkdir(output, { recursive: true })
const server = await createServer({ configFile: false, root: resolve('src/renderer'), plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  server: { host: '127.0.0.1', port: 18767, strictPort: true } })
// addInitScript 只序列化函数体（闭包不进页面），数据必须在函数内自构造
const installTokenStub = () => {
  const BUCKET_MS = 30 * 60 * 1000
  const buckets = Array.from({ length: 60 }, (_, index) => {
    const i = 60 - index
    const bucketStart = Math.floor((Date.now() - i * BUCKET_MS) / BUCKET_MS) * BUCKET_MS
    return { bucketStart, model: i % 3 === 0 ? 'model-a' : 'model-b', inputTokens: 1000 + i * 37, outputTokens: 500 + i * 13, requestCount: 1 }
  })
  // 多模型数据：让按模型表足够长，页面能真实溢出滚动（贴近真实使用场景）
  const summary = Array.from({ length: 8 }, (_, index) => ({
    model: `model-${String.fromCharCode(97 + index)}`,
    totalInput: (12 - index) * 1_000_000, totalOutput: (7 - index) * 500_000, count: 80 - index * 9
  }))
  window.api.token = { summary: async () => summary, buckets: async () => buckets }
}
let browser, page
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.env.FLOW_BROWSER_CHANNEL ? { channel: process.env.FLOW_BROWSER_CHANNEL } : {}) })
  page = await browser.newPage({ viewport: { width: 1450, height: 900 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(installFlowUiFixture)
  await page.addInitScript(installTokenStub)
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
  await page.locator('.conversation-flow').waitFor()
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  await page.getByRole('tab', { name: '用量', exact: true }).click()
  await page.locator('.usage-card').first().waitFor()

  // 1) 标题栏几何：通铺到内容列左上角（不含侧边栏列），高 56px（与窗口控制区同高），
  //    不随 .settings-page 内边距内缩
  const bar = page.locator('.settings-page-title')
  const barBox = await bar.boundingBox()
  const view = page.locator('.settings-view')
  const viewBox = await view.boundingBox()
  assert.equal(barBox.x, viewBox.x, 'title bar must start at the left edge of the content column')
  assert.equal(barBox.y, 0, 'title bar must start at the top window edge')
  assert.equal(barBox.height, 56, 'title bar height must equal --window-controls-height')
  assert.equal(barBox.width, viewBox.width, 'title bar must span the full scroll-viewport width')
  assert.equal(await bar.evaluate(el => getComputedStyle(el).position), 'sticky')
  assert.doesNotMatch(await bar.evaluate(el => getComputedStyle(el).backgroundColor), /rgba\(0, 0, 0, 0\)/, 'title bar must be opaque (hides scrolled content)')

  // 2) 拖拽区：::before 常驻 drag，且物理避开右侧 138px 窗口控制区（CSS 注释见 chat-topbar 行）
  const pseudo = await bar.evaluate(el => {
    const style = getComputedStyle(el, '::before')
    return { region: style.webkitAppRegion, content: style.content }
  })
  assert.equal(pseudo.region, 'drag', 'title bar ::before must be a drag region')
  assert.ok(pseudo.content && pseudo.content !== 'none', 'title bar ::before must paint a (hit-testable) drag strip')

  // 3) 滚动后标题栏仍钉在顶部（修复前：h1 随内容滚走，顶部无拖拽区）
  await page.locator('.settings-view').evaluate(el => { el.scrollTop = el.scrollHeight })
  const scrolled = await page.locator('.settings-view').evaluate(el => el.scrollTop)
  assert.ok(scrolled > 100, `content must actually scroll (scrollTop=${scrolled})`)
  const stickyBox = await bar.boundingBox()
  assert.equal(stickyBox.y, 0, 'title bar must stay pinned at top after scrolling')
  assert.equal(stickyBox.height, 56)

  // 4) 内容在标题栏下方滚动（被不透明栏覆盖，不再从控制区后面露出）
  const cardBox = await page.locator('.usage-card').first().boundingBox()
  assert.ok(cardBox.y < 56, `scrolled content must slide under the title bar (card top=${cardBox.y})`)
  const underStrip = await page.evaluate(() => {
    const el = document.elementFromPoint(500, 28)
    return el?.closest('.settings-page-title') !== null
  })
  assert.ok(underStrip, 'top strip must be covered by the title bar (not scrolled content)')
  const controlsOnTop = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth - 20, 28)
    return el?.closest('.window-controls') !== null
  })
  assert.ok(controlsOnTop, 'window control buttons must stay on top of the title bar')

  // 5) 明/暗主题截图
  await page.screenshot({ path: resolve(output, 'settings-titlebar-scrolled-light.png') })
  await page.evaluate(async () => (await import('/src/store/index.ts')).useAppStore.getState().setTheme('dark'))
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await page.screenshot({ path: resolve(output, 'settings-titlebar-scrolled-dark.png') })
  assert.deepEqual(errors, [])
  console.log(`Settings title bar UI passed: sticky 56px bar, persistent drag region, content scrolls under, window controls on top. ${output}`)
} catch (error) {
  if (page) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: resolve(output, 'failure.png') }) }
  throw error
} finally { await browser?.close(); await server.close() }
