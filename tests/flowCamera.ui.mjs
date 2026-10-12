import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { installFlowUiFixture } from './helpers/flowUiFixture.mjs'
import { assertFocusedNode, settleViewport, viewportStyle } from './helpers/flowCameraChecks.mjs'

const server = await createServer({ configFile: false, root: resolve('src/renderer'), plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  server: { host: '127.0.0.1', port: 18762, strictPort: true } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.env.FLOW_BROWSER_CHANNEL ? { channel: process.env.FLOW_BROWSER_CHANNEL } : {}) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(installFlowUiFixture)
  await page.addInitScript(() => {
    const message = (id, role, content) => ({ id, sessionId: 'parent', role, content, timestamp: 1, status: 'done' })
    flowUiFixture.histories.parent.splice(0, Infinity, message('long-u', 'user', '长流程'))
    for (let index = 0; index < 50; index++) flowUiFixture.histories.parent.push(message(`long-a${index}`, 'assistant', `发言 ${index}`))
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
  // The final node begins far outside the initial viewport and has never been DOM-measured.
  await assertFocusedNode(page, '发言 49')
  assert.ok(await page.locator('.flow-card').count() < 10, 'follow keeps viewport virtualization instead of mounting all history')
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelector('.flow-toolbar-actions button[aria-label="跟随运行"]')?.getAttribute('aria-pressed') === 'false')
  await page.getByRole('button', { name: '跟随运行', exact: true }).click()
  await assertFocusedNode(page, '发言 49')

  await page.evaluate(() => {
    flowUiFixture.emit('agent.onRunningChange', { sessionId: 'parent', running: true })
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId: 'latest-live', phase: 'start', content: '', toolCalls: [] })
    flowUiFixture.emit('agent.onToken', { sessionId: 'parent', messageId: 'latest-live', token: '最新发言' })
  })
  await assertFocusedNode(page, '最新发言')
  const fixed = await viewportStyle(page)
  await page.evaluate(() => flowUiFixture.emit('agent.onToken', { sessionId: 'parent', messageId: 'latest-live', token: '，继续输出' }))
  await page.waitForFunction(() => document.querySelector('.flow-speech-text')?.textContent?.includes('继续输出')
    || [...document.querySelectorAll('.flow-speech-text')].some(node => node.textContent === '最新发言，继续输出'))
  assert.equal(await viewportStyle(page), fixed, 'text deltas do not move the camera')
  await page.getByRole('button', { name: '最新输出', exact: true }).click()
  await assertFocusedNode(page, '最新发言，继续输出')
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await settleViewport(page)
  await page.locator('.flow-speech').filter({ has: page.locator('.flow-speech-text', { hasText: /^发言 25$/ }) }).click()
  assert.equal(await page.locator('.flow-detail-body .markdown-body').innerText(), '发言 25')
  await page.getByRole('button', { name: '跟随运行', exact: true }).click()
  await assertFocusedNode(page, '最新发言，继续输出')
  await page.waitForFunction(() => document.querySelector('.flow-detail-body .markdown-body')?.textContent === '最新发言，继续输出')
  await page.evaluate(() => {
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId: 'follow-next', phase: 'start', content: '', toolCalls: [] })
    flowUiFixture.emit('agent.onReasoning', { sessionId: 'parent', messageId: 'follow-next', token: '新节点思考' })
  })
  await page.waitForFunction(() => document.querySelector('.flow-detail-body .markdown-body')?.textContent === '新节点思考')
  assert.equal(await page.getByRole('tab', { name: '思考', exact: true }).getAttribute('aria-selected'), 'true')
  await page.evaluate(() => flowUiFixture.emit('agent.onToken', { sessionId: 'parent', messageId: 'follow-next', token: '跟随新发言' }))
  await assertFocusedNode(page, '跟随新发言')
  await page.waitForFunction(() => document.querySelector('.flow-detail-body .markdown-body')?.textContent === '跟随新发言')
  assert.equal(await page.locator('.flow-speech.is-selected .flow-speech-text').innerText(), '跟随新发言')
  await page.locator('.flow-inner-step.thinking').click()
  assert.equal(await page.getByRole('button', { name: '跟随运行', exact: true }).getAttribute('aria-pressed'), 'false')
  assert.equal(await page.locator('.flow-detail-body .markdown-body').innerText(), '新节点思考')
  await page.getByRole('button', { name: '跟随运行', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.flow-detail-body .markdown-body')?.textContent === '跟随新发言')
  // Explicit detail browsing pauses both follows and survives subsequent nodes.
  await page.getByRole('tab', { name: '思考', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '跟随运行', exact: true }).getAttribute('aria-pressed'), 'false')
  await page.evaluate(() => {
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId: 'paused-next', phase: 'start', content: '', toolCalls: [] })
    flowUiFixture.emit('agent.onToken', { sessionId: 'parent', messageId: 'paused-next', token: '暂停期间节点' })
  })
  await page.waitForFunction(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    return useAppStore.getState().messages.parent.at(-1)?.content === '暂停期间节点'
  })
  assert.equal(await page.locator('.flow-detail-body .markdown-body').innerText(), '新节点思考')
  await page.getByRole('button', { name: '跟随运行', exact: true }).click()
  await assertFocusedNode(page, '暂停期间节点')
  await page.waitForFunction(() => document.querySelector('.flow-detail-body .markdown-body')?.textContent === '暂停期间节点')
  // Pausing via the viewport keeps the most recently followed selection.
  await page.getByRole('button', { name: '跟随运行', exact: true }).click()
  assert.equal(await page.locator('.flow-detail-body .markdown-body').innerText(), '暂停期间节点')
  await page.getByRole('button', { name: '跟随运行', exact: true }).click()
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  await assertFocusedNode(page, '暂停期间节点')

  const canvas = await page.locator('.flow-canvas').boundingBox()
  await page.mouse.move(canvas.x + 40, canvas.y + 30)
  await page.mouse.wheel(0, -240)
  await page.waitForFunction(() => document.querySelector('.flow-toolbar-actions button[aria-label="跟随运行"]')?.getAttribute('aria-pressed') === 'false')
  await settleViewport(page)
  const manual = await viewportStyle(page)
  await page.evaluate(() => {
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId: 'next-live', phase: 'start', content: '', toolCalls: [] })
    flowUiFixture.emit('agent.onToken', { sessionId: 'parent', messageId: 'next-live', token: '下一节点' })
  })
  await page.waitForFunction(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    return useAppStore.getState().messages.parent.at(-1)?.content === '下一节点'
  })
  assert.equal(await viewportStyle(page), manual, 'disabled follow preserves manual navigation when nodes arrive')
  await page.getByRole('button', { name: '跟随运行', exact: true }).click()
  await assertFocusedNode(page, '下一节点')
  assert.equal(await page.locator('.flow-inspector').count(), 0, 'closed details stay closed when following a new node')
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    useAppStore.getState().setTheme('dark')
  })
  const panel = page.locator('.dock-conversation')
  await panel.locator('.dock-panel-menu summary').click()
  await page.getByRole('menuitem', { name: '窗口内浮动', exact: true }).click()
  await assertFocusedNode(page, '下一节点')
  await panel.locator('.dock-panel-menu summary').click()
  await page.getByRole('menuitem', { name: '停靠中央', exact: true }).click()
  await assertFocusedNode(page, '下一节点')
  assert.deepEqual(errors, [])
  console.log('Camera UI passed: unmeasured latest, synchronized inspector, reasoning/content, manual browse and resume, closed inspector, token stability and pane remounts')
} finally {
  await browser?.close()
  await server.close()
}
