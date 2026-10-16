import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { installFlowUiFixture } from './helpers/flowUiFixture.mjs'
import { assertWindowControlHitAreas } from './helpers/windowControlsChecks.mjs'
import { assertPassiveLanes } from './helpers/flowLaneChecks.mjs'
import { assertFoldedAppearance, assertStreamingDetail } from './helpers/flowDetailChecks.mjs'
import { assertResponsiveSpeech } from './helpers/speechSizingChecks.mjs'
import { assertProviderConcurrencySettings } from './helpers/providerConcurrencyUiChecks.mjs'
import { assertProviderWorkspace } from './helpers/providerWorkspaceUiChecks.mjs'
import { assertInnerDetailFollow } from './helpers/innerDetailFollowChecks.mjs'

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
  page.on('console', message => { if (message.type() === 'warn' && message.text().includes('[React Flow]')) errors.push(message.text()) })
  await page.addInitScript(installFlowUiFixture)
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page.locator('.conversation-flow').waitFor()
  await page.getByRole('button', { name: '并行协作', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '并行协作', exact: true }).getAttribute('aria-pressed'), 'true')
  const branches = page.getByRole('button', { name: '展开子任务', exact: true })
  assert.match(await branches.getAttribute('title'), /仅显示或隐藏/)
  const executionCalls = () => page.evaluate(() => flowUiFixture.calls.filter(call => call[0] === 'agent' && ['run', 'abort'].includes(call[1])))
  const beforeBranches = await executionCalls()
  await branches.click()
  assert.equal(await branches.getAttribute('aria-pressed'), 'false')
  assert.equal(await page.getByRole('button', { name: '并行协作', exact: true }).getAttribute('aria-pressed'), 'true')
  await branches.click()
  assert.equal(await branches.getAttribute('aria-pressed'), 'true')
  assert.deepEqual(await executionCalls(), beforeBranches, 'branch visibility never launches or stops an agent')
  assert.equal(await page.locator('.session-nav .session-title').count(), 2, 'sidebar lists main sessions only')
  assert.equal(await page.locator('.session-nav').getByText('架构梳理', { exact: true }).count(), 0)
  assert.equal(await page.locator('.session-nav').getByText('权限审查', { exact: true }).count(), 0)
  assert.equal(await page.locator('.window-titlebar').count(), 0, 'the separate titlebar is removed')
  assert.equal(Math.round((await page.locator('.app-shell').boundingBox()).y), 0, 'the content starts at the top edge')
  assert.equal(Math.round((await page.locator('.chat-topbar').boundingBox()).y), 0)
  assert.equal(await page.locator('.window-controls button').count(), 3)
  await assertWindowControlHitAreas(page, '.chat-topbar')
  for (let index = 0; index < 3; index++) await page.locator('.window-controls button').nth(index).click()
  assert.deepEqual(await page.evaluate(() => flowUiFixture.calls.filter(call => call[0] === 'window').map(call => call[1])),
    ['minimize', 'toggleMaximize', 'close'], 'window controls keep the original main IPC boundary')
  await page.waitForFunction(() => document.querySelector('.flow-count')?.textContent === '11 个节点')
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-card').length === 11)
  assert.equal(await page.locator('.flow-lane').count(), 2)
  // Viewport clipping mounts only visible elements; wait until fitting has exposed the whole fixture.
  const allEdges = await page.locator('.react-flow__edge').count()
  assert.equal(allEdges, 12, 'four main links, four child links, two forks and two result returns')
  await waitViewportSettled(page)
  await assertPassiveLanes(page)
  await assertFoldedAppearance(page)
  await page.locator('.flow-inner-step.tool').filter({ hasText: /^read$/ }).click()
  await page.locator('.flow-inspector').waitFor()
  const inspectedText = await page.locator('.flow-detail-body').innerText()
  const inspectedTab = await page.locator('.flow-detail-tabs button.active').innerText()
  await page.getByRole('button', { name: '打开所属会话', exact: true }).click()
  await page.waitForFunction(async () => (await import('/src/store/index.ts')).useAppStore.getState().activeSessionId === 'child-a')
  assert.equal(await page.locator('.session-nav .session-title').count(), 2, 'opening child history never inserts it into the sidebar')
  assert.match(await page.locator('.session-nav button.active').innerText(), /项目架构分析/)
  await page.locator('.sidebar').getByText('项目架构分析', { exact: true }).click()
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.locator('.flow-inner-step.tool').filter({ hasText: /^read$/ }).click()
  const blank = await page.locator('.flow-canvas').boundingBox()
  await page.mouse.click(blank.x + 8, blank.y + 8)
  assert.ok(await page.locator('.flow-inspector').isVisible(), 'blank canvas clicks retain the open inspector')
  assert.equal(await page.locator('.flow-detail-body').innerText(), inspectedText, 'blank clicks preserve the inspected step')
  assert.equal(await page.locator('.flow-detail-tabs button.active').innerText(), inspectedTab)
  assert.equal(await page.locator('.flow-step-list button').count(), 2, 'the spoken message exposes its LLM and tool actions')
  assert.match(await page.locator('.flow-detail-body').innerText(), /SessionService/)
  await page.locator('.flow-step-list button').first().click()
  assert.match(await page.locator('.flow-detail-body').innerText(), /读取架构说明/)
  await page.locator('.flow-step-list button').last().click()
  await page.getByRole('tab', { name: '参数', exact: true }).click()
  assert.match(await page.locator('.flow-detail-body').innerText(), /file_path/)
  await page.getByRole('button', { name: '关闭详情', exact: true }).click()
  await page.locator('.flow-inner-step.thinking').click()
  await page.waitForFunction(() => document.querySelector('.flow-detail-tabs button.active')?.textContent === '思考')
  assert.match(await page.locator('.flow-detail-body').innerText(), /两项审查可以独立进行/)
  await page.locator('.flow-inner-step.tool').filter({ hasText: /^spawn_subagent$/ }).first().click()
  await page.waitForFunction(() => document.querySelector('.flow-detail-tabs button.active')?.textContent === '结果')
  assert.match(await page.locator('.flow-detail-body').innerText(), /task-a/)
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

  // Mouse wheel changes scale; dragging moves the canvas without changing scale.
  await assertPassiveLanes(page)
  await assertFoldedAppearance(page)
  await page.screenshot({ path: resolve(output, 'folded-history-dark.png') })
  await page.getByRole('button', { name: '自动跟随', exact: true }).click()
  await waitViewportSettled(page)
  const canvas = await page.locator('.flow-canvas').boundingBox()
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + 24)
  const wheelStart = await readViewport(page)
  await page.mouse.wheel(0, -240)
  await page.waitForFunction(zoom => new DOMMatrix(document.querySelector('.react-flow__viewport').style.transform).a > zoom, wheelStart.zoom)
  await waitViewportSettled(page)
  assert.equal(await page.getByRole('button', { name: '自动跟随', exact: true }).getAttribute('aria-pressed'), 'true', 'wheel zoom keeps follow enabled')
  const enlarged = await readViewport(page)
  await page.mouse.wheel(0, 240)
  await page.waitForFunction(zoom => new DOMMatrix(document.querySelector('.react-flow__viewport').style.transform).a < zoom, enlarged.zoom)
  await waitViewportSettled(page)
  const dragStart = await readViewport(page)
  await page.mouse.down()
  await page.mouse.move(canvas.x + canvas.width / 2 + 60, canvas.y + 64, { steps: 5 })
  await page.mouse.up()
  await waitViewportSettled(page)
  const dragged = await readViewport(page)
  assert.equal(dragged.zoom, dragStart.zoom, 'dragging preserves zoom')
  assert.ok(dragged.x > dragStart.x && dragged.y > dragStart.y, 'dragging still pans the canvas')
  assert.equal(await page.getByRole('button', { name: '自动跟随', exact: true }).getAttribute('aria-pressed'), 'false', 'dragging pauses follow')

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
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await waitViewportSettled(page)
  await page.locator('.flow-turn').click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-turn').length === 0)
  assert.equal(await page.locator('.flow-inspector').count(), 0, 'expanding a folded round does not leave a stale detail selection')
  assert.equal(await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    return useAppStore.getState().messages.parent.filter(message => message.id === 'old-a').length
  }), 1, 'individual expansion preserves the authoritative history')
  await page.getByRole('button', { name: '展开历史', exact: true }).click()
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-turn').length === 0)
  await page.getByRole('button', { name: '折叠历史', exact: true }).click()
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-turn').length === 1)
  await page.getByRole('button', { name: '展开子任务', exact: true }).click()
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-card').length === 8)
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
  await assertWindowControlHitAreas(page, '.chat-topbar')
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
  await page.getByRole('button', { name: 'Auto-follow', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    useAppStore.setState(state => ({ sessions: [...state.sessions, { ...state.sessions[0], id: 'empty', title: 'Empty' }],
      activeSessionId: 'empty', messages: { ...state.messages, empty: [] } }))
  })
  await page.locator('.flow-empty-path').waitFor()
  assert.equal(await page.locator('.flow-card').count(), 0, 'a new conversation starts with an empty canvas')
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    const { default: i18n } = await import('/src/i18n/index.ts')
    await i18n.changeLanguage('zh')
    useAppStore.getState().setFontSize(15)
    useAppStore.getState().setTheme('light')
    const make = (id, role, content, extra = {}) => ({ id, sessionId: 'dense', role, content, timestamp: 1, status: 'done', ...extra })
    const history = [make('dense-u', 'user', '检查 Cloudflare 部署方案，核对持久化与域名配置。')]
    for (let index = 0; index < 20; index++) {
      const name = ['read', 'query-docs', 'grep'][index % 3]
      history.push(make(`dense-a${index}`, 'assistant', index === 0 ? '先查部署文档，核对持久化配置。' : index === 10 ? '持久化方案已确认，继续检查域名和网络。' : '', {
        reasoning: `正在核对第 ${index + 1} 项配置。`,
        toolCalls: [{ id: 'reused-call', type: 'function', function: { name, arguments: JSON.stringify({ query: '部署配置', step: index + 1 }) } }]
      }), make(`dense-t${index}`, 'tool', `步骤 ${index + 1} 的配置与文档已核对。`, { toolName: name, toolCallId: 'reused-call' }))
    }
    history.push(make('dense-reply', 'assistant', '## 部署分析结果\n\n配置与文档核对已完成。详细过程保留在每段发言内部。'))
    useAppStore.setState(state => ({ sessions: [...state.sessions, { ...state.sessions[0], id: 'dense', title: 'Cloudflare 部署分析' }],
      activeSessionId: 'dense', messages: { ...state.messages, dense: history } }))
  })
  await page.waitForFunction(() => document.querySelectorAll('.flow-card').length === 4)
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await waitViewportSettled(page)
  assert.equal(await page.locator('.react-flow__edge').count(), 3, 'twenty calls live inside two spoken messages followed by the reply')
  assert.match(await page.locator('.flow-speech footer').first().innerText(), /LLM 10 轮 · 工具 10 次/)
  assert.equal(await page.locator('.flow-inner-step').count(), 12, 'only six inner items per speech are previewed')
  assert.equal(await page.locator('.flow-inner-more').count(), 2)
  assert.equal(await page.locator('.flow-speech-text').first().innerText(), '先查部署文档，核对持久化配置。')
  await page.screenshot({ path: resolve(output, 'speech-nodes-light.png') })
  await page.evaluate(async () => { const { useAppStore } = await import('/src/store/index.ts'); useAppStore.getState().setTheme('dark') })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await page.locator('.flow-card.flow-speech').first().click()
  assert.equal(await page.locator('.flow-step-list button').count(), 20)
  assert.match(await page.locator('.flow-detail-body').innerText(), /先查部署文档/)
  await page.locator('.flow-inner-step.thinking').first().click()
  await page.waitForFunction(() => document.querySelector('.flow-detail-tabs button.active')?.textContent === '思考')
  assert.match(await page.locator('.flow-detail-body').innerText(), /正在核对第 1 项配置/)
  await waitViewportSettled(page)
  await page.screenshot({ path: resolve(output, 'speech-nodes-dark.png') })
  await page.locator('.flow-inner-more').first().click()
  assert.equal(await page.locator('.flow-step-list button').count(), 20, 'more opens the full ordered trace')
  await page.locator('.flow-step-list button').last().click()
  await page.waitForFunction(() => document.querySelector('.flow-detail-tabs button.active')?.textContent === '结果')
  assert.match(await page.locator('.flow-detail-body').innerText(), /步骤 10 的配置与文档已核对/, 'reused call IDs still select their exact result')
  // Display preferences now persist across session switches (previously a per-mount default).
  // Restore the defaults this scenario asserts before returning to the parent session.
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    useAppStore.getState().setFlowFoldHistory(true)
    useAppStore.getState().setFlowShowChildren(true)
  })
  // Dispatch and silent wait in one utterance retain distinct, drawable inner ports.
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    const parent = flowUiFixture.histories.parent.map(message => message.id === 'w' ? { ...message, content: '' } : message)
    useAppStore.setState(state => ({ activeSessionId: 'parent', runningIds: new Set(), retryStatus: {},
      messages: { ...state.messages, parent }, flowExpandedTurns: { ...state.flowExpandedTurns, parent: [] } }))
  })
  await page.waitForFunction(() => document.querySelector('.flow-count')?.textContent === '10 个节点')
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-card').length === 10)
  const dispatch = page.locator('.flow-speech').filter({ hasText: '分别委托架构梳理和权限审查' })
  assert.equal(await dispatch.locator('.react-flow__handle.source[data-handleid]').count(), 2)
  assert.equal(await dispatch.locator('.react-flow__handle.target[data-handleid]').count(), 1)
  assert.ok(await dispatch.evaluate(card => [...card.querySelectorAll('.flow-inner-port')].every(handle => {
    const port = handle.getBoundingClientRect()
    return port.x + port.width / 2 >= card.getBoundingClientRect().right
  })), 'inner ports sit outside the opaque parent surface, so their edges stay visible')
  assert.equal(await page.locator('.react-flow__edge').count(), 11, 'same-container returns are real edges to the wait port')
  await waitViewportSettled(page)
  await page.screenshot({ path: resolve(output, 'speech-fork-return-dark.png') })
  await page.getByRole('button', { name: '最新输出', exact: true }).click()
  await page.evaluate(() => {
    flowUiFixture.emit('agent.onRunningChange', { sessionId: 'parent', running: true })
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId: 'detail-live', phase: 'start', content: '', toolCalls: [] })
    flowUiFixture.emit('agent.onToken', { sessionId: 'parent', messageId: 'detail-live', token: '实时详情。\n\n' })
  })
  await page.waitForFunction(() => document.querySelector('.flow-count')?.textContent === '11 个节点')
  await page.getByRole('button', { name: '最新输出', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.flow-detail-body')?.textContent.includes('实时详情。'))
  await assertStreamingDetail(page, page, 'detail-live', true)
  await assertResponsiveSpeech(page, output)
  await assertProviderConcurrencySettings(page, output)
  await assertProviderWorkspace(page, output)
  await page.locator('.sidebar').getByText('项目架构分析', { exact: true }).click()
  await assertInnerDetailFollow(page)
  // Canvas display preferences persist across session switches and restarts, while auto-follow stays runtime-only.
  const branchesButton = page.getByRole('button', { name: '展开子任务', exact: true })
  assert.equal(await branchesButton.getAttribute('aria-pressed'), 'true', 'branches are visible before the persistence check')
  await branchesButton.click()
  await page.getByRole('button', { name: '展开历史', exact: true }).click()
  assert.equal(await branchesButton.getAttribute('aria-pressed'), 'false', 'branch visibility toggles off')
  assert.equal(await page.getByRole('button', { name: '折叠历史', exact: true }).getAttribute('aria-pressed'), 'false', 'history toggles to fully expanded')
  assert.equal(await page.evaluate(() => localStorage.getItem('zhumora.flowShowChildren')), '0')
  assert.equal(await page.evaluate(() => localStorage.getItem('zhumora.flowFoldHistory')), '0')
  const followButton = page.getByRole('button', { name: '自动跟随', exact: true })
  if (await followButton.getAttribute('aria-pressed') === 'true') await followButton.click()
  assert.equal(await followButton.getAttribute('aria-pressed'), 'false', 'follow is turned off for the persistence check')
  await page.locator('.sidebar').getByText('浏览器任务', { exact: true }).click()
  await page.locator('.sidebar').getByText('项目架构分析', { exact: true }).click()
  assert.equal(await branchesButton.getAttribute('aria-pressed'), 'false', 'branch visibility follows the stored choice after switching sessions')
  assert.equal(await page.getByRole('button', { name: '折叠历史', exact: true }).getAttribute('aria-pressed'), 'false', 'history stays expanded across the session switch')
  assert.equal(await followButton.getAttribute('aria-pressed'), 'true', 'auto-follow is runtime state and resets on remount')
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    useAppStore.getState().setFlowShowChildren(true)
    useAppStore.getState().setFlowFoldHistory(true)
  })
  await page.reload()
  await page.locator('.conversation-flow').waitFor()
  await page.waitForFunction(() => document.querySelector('.flow-count')?.textContent === '11 个节点')
  assert.equal(await branchesButton.getAttribute('aria-pressed'), 'true', 'branch visibility restores from storage after a restart')
  assert.equal(await page.getByRole('button', { name: '展开历史', exact: true }).getAttribute('aria-pressed'), 'true', 'history fold restores from storage after a restart')
  assert.equal(await followButton.getAttribute('aria-pressed'), 'true', 'auto-follow resets to its default on reload')
  await page.locator('.sidebar').getByText('浏览器任务', { exact: true }).click()
  await page.locator('.sidebar').getByText('项目架构分析', { exact: true }).click()
  assert.equal(await branchesButton.getAttribute('aria-pressed'), 'true', 'the restored branch visibility follows the user back to the session')
  assert.deepEqual(errors, [], 'renderer should have no uncaught errors')
  console.log(`Flow UI passed: responsive speech height/width, latest text, bounded tool scrolling/ports, light/dark, folding, live details, ID routing and camera stability. Screenshots: ${output}`)
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

async function readViewport(page) {
  return page.evaluate(() => {
    const matrix = new DOMMatrix(document.querySelector('.react-flow__viewport').style.transform)
    return { x: matrix.e, y: matrix.f, zoom: matrix.a }
  })
}
