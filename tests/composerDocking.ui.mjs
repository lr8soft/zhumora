import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { _electron } from 'playwright'
import { installFlowUiFixture } from './helpers/flowUiFixture.mjs'
import { settleViewport } from './helpers/flowCameraChecks.mjs'

const output = resolve('.temp/composer-ui')
await mkdir(output, { recursive: true })
await build({ entryPoints: { main: 'tests/helpers/panelElectronEntry.ts', preload: 'tests/helpers/panelTestPreload.ts' },
  outdir: output, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const server = await createServer({ configFile: false, root: resolve('src/renderer'), plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  server: { host: '127.0.0.1', port: 18763, strictPort: true } })
let electron, page, nativeLog = ''
const errors = []
const watchdog = setTimeout(() => electron?.process().kill(), 120000)
try {
  await server.listen()
  electron = await _electron.launch({ args: ['--in-process-gpu', resolve(output, 'main.cjs')], cwd: resolve('.') })
  electron.process().stderr.on('data', chunk => { nativeLog = (nativeLog + String(chunk)).slice(-5000) })
  page = await electron.firstWindow()
  const observe = target => { target.setDefaultTimeout(15000); target.on('pageerror', error => errors.push(error.message)) }
  observe(page)
  await page.addInitScript(installFlowUiFixture)
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
  const inputPanel = page.locator('.dock-composer')
  await inputPanel.locator('textarea').waitFor()
  assert.equal(await inputPanel.getAttribute('data-mode'), 'bottom')
  const host = await page.locator('.dock-workspace').boundingBox()
  const bottom = await inputPanel.boundingBox()
  assert.ok(bottom.y + bottom.height <= host.y + host.height + 1, 'input belongs inside the common workspace')
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-card').length === 11)
  await settleViewport(page)
  const camera = await page.locator('.react-flow__viewport').getAttribute('style')
  const draft = '保留的输入草稿\n第二行内容'
  await page.getByRole('button', { name: '并行协作', exact: true }).click()
  await inputPanel.locator('textarea').fill(draft)
  assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'), camera)
  const image = { name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') }
  await inputPanel.locator('input[type=file]').setInputFiles(image)
  await inputPanel.locator('.chat-image-preview').waitFor()
  for (const side of ['停靠左侧', '停靠右侧', '停靠顶部', '停靠中央', '停靠底部', '窗口内浮动', '停靠底部']) {
    await place(page, 'composer', side)
    assert.equal(await inputPanel.locator('textarea').inputValue(), draft, 'relocation preserves unsent text')
    assert.equal(await inputPanel.locator('.chat-image-preview').count(), 1, 'relocation preserves image attachments')
    assert.equal(await inputPanel.getByRole('button', { name: '并行协作', exact: true }).getAttribute('aria-pressed'), 'true')
  }
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-card').length === 11)
  await page.locator('.flow-inner-step.tool').filter({ hasText: /^read$/ }).click()
  await place(page, 'details', '停靠底部')
  await place(page, 'details', '窗口内浮动')
  const detailHeader = await page.locator('.dock-details .dock-panel-header').boundingBox()
  const composerBox = await inputPanel.boundingBox()
  await page.mouse.move(detailHeader.x + 18, detailHeader.y + 12)
  await page.mouse.down()
  await page.mouse.move(host.x + 240, composerBox.y + composerBox.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.waitForFunction(() => {
    const details = document.querySelector('.dock-details').getBoundingClientRect()
    const composer = document.querySelector('.dock-composer').getBoundingClientRect()
    return details.bottom > composer.top + 20 && details.top < composer.bottom
  })
  await page.screenshot({ path: resolve(output, 'workspace-overlap-light.png') })
  await place(page, 'details', '停靠右侧')
  await place(page, 'composer', '窗口内浮动')
  await page.evaluate(async () => { const { useAppStore } = await import('/src/store/index.ts'); useAppStore.getState().setTheme('dark') })
  await page.screenshot({ path: resolve(output, 'composer-floating-dark.png') })
  const listeners = await page.evaluate(() => flowUiFixture.listeners())
  const nextWindow = electron.waitForEvent('window')
  await inputPanel.getByRole('button', { name: '在独立窗口打开', exact: true }).click()
  const popup = await nextWindow
  observe(popup)
  await popup.locator('textarea').waitFor()
  assert.equal(await page.locator('textarea').count(), 0, 'the input moved, without creating a duplicate')
  assert.equal(await popup.locator('textarea').inputValue(), draft)
  assert.equal(await popup.locator('.chat-image-preview').count(), 1)
  assert.deepEqual(await page.evaluate(() => flowUiFixture.listeners()), listeners, 'no second App/Agent event subscription')
  await popup.getByRole('button', { name: '手动批准', exact: true }).click()
  const menu = await popup.locator('.mode-menu').boundingBox()
  const viewport = await popup.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert.ok(menu.x >= 0 && menu.y >= 31 && menu.x + menu.width <= viewport.width && menu.y + menu.height <= viewport.height, 'input menu stays inside its native window')
  await popup.locator('.mode-menu-item').filter({ hasText: '全自动' }).click()
  await popup.getByRole('button', { name: 'Avatar 关闭', exact: true }).click()
  await popup.getByRole('dialog').waitFor()
  await popup.getByRole('button', { name: '取消', exact: true }).click()
  await popup.locator('textarea').evaluate(textarea => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
  assert.equal(await page.evaluate(() => flowUiFixture.calls.filter(call => call[1] === 'run').length), 0, 'IME confirmation does not submit')
  await popup.locator('textarea').press('Control+End')
  await popup.locator('textarea').press('Shift+Enter')
  assert.equal(await popup.locator('textarea').inputValue(), `${draft}\n`, 'Shift+Enter still inserts a newline')
  await popup.locator('textarea').fill(draft)
  await popup.locator('textarea').press('Enter')
  await page.waitForFunction(() => flowUiFixture.calls.filter(call => call[1] === 'run').length === 1)
  const sent = await page.evaluate(() => flowUiFixture.calls.find(call => call[1] === 'run'))
  assert.equal(sent[2][0], 'parent')
  assert.equal(sent[2][1].text, draft)
  assert.equal(sent[2][1].images.length, 1)
  assert.equal(sent[2][2].approveMode, 'full')
  assert.equal(sent[2][2].preferParallel, true)
  await page.waitForFunction(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    return useAppStore.getState().messages.parent.some(message => message.id.startsWith('fixture-user-') && message.content.includes('保留的输入草稿'))
  })
  assert.equal(await popup.locator('textarea').inputValue(), '')
  assert.equal(await popup.getByRole('button', { name: '并行协作', exact: true }).getAttribute('aria-pressed'), 'true', 'sending retains the collaboration preference')
  assert.equal(await popup.locator('.chat-image-preview').count(), 0)
  await page.evaluate(() => flowUiFixture.emit('agent.onRunningChange', { sessionId: 'parent', running: false }))
  await popup.locator('textarea').fill('继续进行并行工作')
  await popup.locator('textarea').press('Enter')
  await page.waitForFunction(() => flowUiFixture.calls.filter(call => call[1] === 'run').length === 2)
  assert.equal(await page.evaluate(() => flowUiFixture.calls.filter(call => call[1] === 'run').at(-1)[2][2].preferParallel), true, 'the next send keeps the preference without another click')
  assert.equal(await popup.getByRole('button', { name: '并行协作', exact: true }).getAttribute('aria-pressed'), 'true')
  await popup.getByRole('button', { name: '并行协作', exact: true }).click()
  await popup.locator('textarea').fill('恢复自动分工')
  await popup.locator('textarea').press('Enter')
  await page.waitForFunction(() => flowUiFixture.calls.filter(call => call[1] === 'run').length === 3)
  assert.equal(await page.evaluate(() => flowUiFixture.calls.filter(call => call[1] === 'run').at(-1)[2][2].preferParallel), false, 'manual off returns subsequent sends to the default delegation policy')
  await page.evaluate(() => flowUiFixture.emit('agent.onRunningChange', { sessionId: 'parent', running: true }))
  await popup.locator('textarea').fill('下一条未发送草稿')
  await popup.locator('textarea').press('Enter')
  assert.equal(await page.evaluate(() => flowUiFixture.calls.filter(call => call[1] === 'run').length), 3, 'running sessions cannot receive another run')
  await popup.screenshot({ path: resolve(output, 'composer-window-dark.png') })
  await popup.close()
  await inputPanel.locator('textarea').waitFor()
  assert.equal(await inputPanel.getAttribute('data-mode'), 'bottom')
  assert.equal(await inputPanel.locator('textarea').inputValue(), '下一条未发送草稿')
  await page.locator('.sidebar').getByText('浏览器任务', { exact: true }).click()
  assert.equal(await page.locator('textarea').inputValue(), '', 'drafts do not cross sessions')
  assert.equal(await page.getByRole('button', { name: '并行协作', exact: true }).getAttribute('aria-pressed'), 'false', 'conversation workflow preferences do not leak into other sessions')
  assert.equal(await page.locator('.chat-image-preview').count(), 0)
  await page.locator('.sidebar').getByText('项目架构分析', { exact: true }).click()
  await page.getByRole('button', { name: '展开历史', exact: true }).click()
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.locator('.flow-inner-step.tool').filter({ hasText: /^read$/ }).click()
  await page.getByRole('button', { name: '打开所属会话', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.dock-composer')?.textContent.includes('由主 Agent 分配任务'))
  assert.equal(await page.locator('textarea').count(), 0, 'a child owned by an active parent retains its read-only input behavior')
  assert.deepEqual(errors, [])
  console.log(`Composer UI passed: shared workspace overlap, all docks, preserved drafts/images, native menus/IME/send, run guards and session isolation. Screenshots: ${output}`)
} catch (error) {
  if (nativeLog) console.error(nativeLog)
  if (page && !page.isClosed()) {
    console.error(await page.locator('body').innerText())
    await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {})
  }
  throw error
} finally {
  clearTimeout(watchdog)
  await electron?.close()
  await server.close()
}

async function place(page, id, name) {
  const panel = page.locator(`[data-panel="${id}"]`)
  await panel.locator('.dock-panel-menu summary').click()
  await page.locator(`[data-menu-panel="${id}"]`).getByRole('menuitem', { name, exact: true }).click()
}
