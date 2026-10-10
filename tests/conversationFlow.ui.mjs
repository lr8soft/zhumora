import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { installFlowUiFixture } from './helpers/flowUiFixture.mjs'

// No Electron, provider requests or user database: this drives the production renderer with explicit IPC fixtures.
const server = await createServer({ configFile: false, root: resolve('src/renderer'), plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  server: { host: '127.0.0.1', port: 0 } })
let browser
let page
const output = resolve('.temp/flow-ui')
await mkdir(output, { recursive: true })
try {
  await server.listen()
  const address = server.httpServer.address()
  browser = await chromium.launch({ headless: true, ...(process.env.FLOW_BROWSER_CHANNEL ? { channel: process.env.FLOW_BROWSER_CHANNEL } : {}) })
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error('Renderer error:', error.message) })
  await page.addInitScript(installFlowUiFixture)
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page.locator('.conversation-flow').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.flow-lane').length === 2)
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-card').length === 16)
  // Viewport clipping mounts only visible elements; wait until fitting has exposed the whole fixture.
  const allEdges = await page.locator('.react-flow__edge').count()
  assert.equal(allEdges, 17, 'seven main steps, six child steps, two forks and two result returns')
  await page.locator('.flow-card header strong').filter({ hasText: /^read$/ }).click()
  await page.locator('.flow-inspector').waitFor()
  assert.match(await page.locator('.flow-detail-body').innerText(), /SessionService/)
  await page.getByRole('tab', { name: '参数', exact: true }).click()
  assert.match(await page.locator('.flow-detail-body').innerText(), /file_path/)
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await waitViewportSettled(page)
  await page.screenshot({ path: resolve(output, 'light.png') })

  await page.evaluate(async () => { const { useAppStore } = await import('/src/store/index.ts'); useAppStore.getState().setTheme('dark') })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await page.getByRole('button', { name: '最新输出', exact: true }).click()
  assert.match(await page.locator('.flow-detail-body').innerText(), /架构分析结果/)
  await waitViewportSettled(page)
  await page.screenshot({ path: resolve(output, 'dark.png') })
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await waitViewportSettled(page)

  // A live token updates its ID and neither relayouts the graph nor steals the user's camera.
  const before = await page.locator('.react-flow__viewport').getAttribute('style')
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    await useAppStore.getState().loadMessages('other')
    flowUiFixture.emit('agent.onRunningChange', { sessionId: 'parent', running: true })
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId: 'live-a', phase: 'start', content: '', toolCalls: [] })
    flowUiFixture.emit('agent.onToken', { sessionId: 'parent', messageId: 'live-a', token: '新的流式输出' })
    flowUiFixture.emit('agent.onRunningChange', { sessionId: 'other', running: true })
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'other', messageId: 'live-a', phase: 'start', content: '', toolCalls: [] })
    flowUiFixture.emit('agent.onToken', { sessionId: 'other', messageId: 'live-a', token: '不应进入主流程' })
  })
  await page.waitForFunction(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    return useAppStore.getState().messages.parent.find(message => message.id === 'live-a')?.content === '新的流式输出'
  })
  assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'), before)
  assert.ok(!(await page.locator('.flow-canvas').innerText()).includes('不应进入主流程'))
  await page.getByRole('button', { name: '展开历史', exact: true }).click()
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-turn').length === 0)
  await page.getByRole('button', { name: '折叠历史', exact: true }).click()
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-turn').length === 1)
  await page.getByRole('button', { name: '子 Agent', exact: true }).click()
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-card').length === 11)
  await page.setViewportSize({ width: 1000, height: 760 })
  await page.getByRole('button', { name: '最新输出', exact: true }).click()
  assert.ok(await page.locator('.flow-inspector').isVisible())
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: resolve(output, 'compact.png') })
  await page.evaluate(() => flowUiFixture.emit('agent.onRetry', { sessionId: 'parent', failedAttempt: 1, maxRetries: 3 }))
  assert.match(await page.locator('.flow-runtime-status').innerText(), /重试/)
  await page.evaluate(() => flowUiFixture.emit('agent.onPermissionRequest', {
    sessionId: 'child-a', permId: 'perm-1', toolName: 'write', args: { file_path: 'report.md' }, level: 'normal'
  }))
  await page.getByRole('dialog').waitFor()
  assert.match(await page.getByRole('dialog').innerText(), /架构梳理/)
  await page.getByRole('button', { name: '允许', exact: true }).click()
  const permissionCall = await page.evaluate(() => flowUiFixture.calls.find(call => call[1] === 'respondPermission'))
  assert.deepEqual(permissionCall, ['agent', 'respondPermission', ['perm-1', true]], 'approval still uses the original permission IPC')
  await page.evaluate(async () => {
    const { default: i18n } = await import('/src/i18n/index.ts')
    const { useAppStore } = await import('/src/store/index.ts')
    await i18n.changeLanguage('en')
    useAppStore.getState().setFontSize(18)
  })
  await page.getByRole('button', { name: 'Follow run', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    useAppStore.setState(state => ({ sessions: [...state.sessions, { ...state.sessions[0], id: 'empty', title: 'Empty' }],
      activeSessionId: 'empty', messages: { ...state.messages, empty: [] } }))
  })
  await page.locator('.flow-empty-path').waitFor()
  assert.equal(await page.locator('.flow-card').count(), 0, 'a new conversation starts with an empty canvas')
  assert.deepEqual(errors, [], 'renderer should have no uncaught errors')
  console.log(`Flow UI passed: light/dark, node details, folding, streaming ID routing, camera stability and compact window. Screenshots: ${output}`)
} catch (error) {
  if (page) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: resolve(output, 'failure.png') }) }
  throw error
} finally {
  await browser?.close()
  await server.close()
}

async function waitViewportSettled(page) {
  await page.evaluate(() => new Promise(resolve => {
    let previous = '', stable = 0
    const started = performance.now()
    const check = () => {
      const style = document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? ''
      stable = style === previous ? stable + 1 : 0
      previous = style
      if (stable >= 6 || performance.now() - started > 3000) resolve()
      else requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  }))
}
