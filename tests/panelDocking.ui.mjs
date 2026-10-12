import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { _electron } from 'playwright'
import { installFlowUiFixture } from './helpers/flowUiFixture.mjs'
import { assertWindowControlHitAreas } from './helpers/windowControlsChecks.mjs'
import { assertFocusedNode, settleViewport } from './helpers/flowCameraChecks.mjs'
import { assertStreamingDetail } from './helpers/flowDetailChecks.mjs'

// Real hidden Electron windows and production renderer; no user database, providers or Agent runs.
const output = resolve('.temp/panel-ui')
await mkdir(output, { recursive: true })
await build({ entryPoints: { main: 'tests/helpers/panelElectronEntry.ts', preload: 'tests/helpers/panelTestPreload.ts' },
  outdir: output, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const server = await createServer({ configFile: false, root: resolve('src/renderer'), plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  server: { host: '127.0.0.1', port: 18761, strictPort: true } })
let electron
let page
let nativeLog = ''
const watchdog = setTimeout(() => electron?.process().kill(), 120000)
try {
  await server.listen()
  electron = await _electron.launch({ args: ['--in-process-gpu', resolve(output, 'main.cjs')], cwd: resolve('.') })
  electron.process().stderr.on('data', chunk => { nativeLog = (nativeLog + String(chunk)).slice(-6000) })
  page = await electron.firstWindow()
  const errors = []
  const observe = target => {
    target.setDefaultTimeout(15000)
    target.on('pageerror', error => errors.push(error.message))
    target.on('console', message => { if (message.type() === 'warn' && message.text().includes('[React Flow]')) errors.push(message.text()) })
  }
  observe(page)
  await page.addInitScript(installFlowUiFixture)
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
  await page.locator('.conversation-flow').waitFor()
  await page.waitForFunction(() => document.querySelector('.flow-count')?.textContent === '11 个节点')
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-card').length === 11)
  await assertWindowControlHitAreas(page, '.chat-topbar')
  await page.locator('.flow-inner-step.tool').filter({ hasText: /^read$/ }).click()
  await page.locator('.dock-details').waitFor()
  assert.match(await page.locator('.flow-detail-body').innerText(), /SessionService/)

  for (const [name, mode] of [['停靠左侧', 'left'], ['停靠顶部', 'top'], ['停靠底部', 'bottom'], ['停靠右侧', 'right'], ['窗口内浮动', 'floating']]) {
    await setPanelMode(page, 'details', name)
    assert.equal(await page.locator('.dock-details').getAttribute('data-mode'), mode)
  }
  const floating = page.locator('.dock-details')
  const host = await page.locator('.dock-workspace').boundingBox()
  const header = await floating.locator('.dock-panel-header').boundingBox()
  await page.mouse.move(header.x + 18, header.y + 12)
  await page.mouse.down()
  await page.mouse.move(host.x + 14, host.y + host.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelector('.dock-details')?.dataset.mode === 'left')
  await setPanelMode(page, 'details', '窗口内浮动')
  const before = await floating.boundingBox()
  const handle = await floating.locator('.dock-panel-resize').boundingBox()
  await page.mouse.move(handle.x + 7, handle.y + 7)
  await page.mouse.down(); await page.mouse.move(handle.x + 70, handle.y + 40, { steps: 5 })
  await page.mouse.up()
  await page.waitForFunction(width => document.querySelector('.dock-details').getBoundingClientRect().width > width, before.width)
  assert.ok((await floating.boundingBox()).width > before.width, 'floating card resize works')
  await page.screenshot({ path: resolve(output, 'floating-light.png') })
  await setPanelMode(page, 'details', '停靠右侧')
  const splitter = await page.locator('.splitter-right').boundingBox()
  const dockedWidth = (await floating.boundingBox()).width
  await page.mouse.move(splitter.x + 2, splitter.y + 40)
  await page.mouse.down(); await page.mouse.move(splitter.x - 50, splitter.y + 40, { steps: 5 }); await page.mouse.up()
  await page.waitForFunction(width => document.querySelector('.dock-details').getBoundingClientRect().width > width, dockedWidth)
  assert.ok((await floating.boundingBox()).width > dockedWidth, 'dock splitters resize the panel')

  // Invalid kinds, arbitrary URLs and child-origin controls cannot escape the typed window capability.
  assert.equal(await page.evaluate(() => window.api.panels.prepare('settings').then(() => false, () => true)), true)
  assert.equal(await page.evaluate(() => window.open('about:blank', 'unapproved-panel') === null), true)
  assert.equal(await page.evaluate(() => window.open('file:///C:/unapproved.html', 'unapproved-file') === null), true)
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(true))
  const nextDetails = electron.waitForEvent('window')
  await page.locator('.dock-details').getByRole('button', { name: '在独立窗口打开', exact: true }).click()
  const detailWindow = await nextDetails
  observe(detailWindow)
  await detailWindow.locator('.flow-inspector').waitFor()
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http:')).webContents.getBackgroundThrottling()), false,
    'a detached viewer keeps the original token flush responsive while its main window is hidden')
  assert.equal(await page.locator('.flow-inspector').count(), 0, 'the detail panel moved, without creating a second copy')
  assert.match(await detailWindow.locator('.flow-detail-body').innerText(), /SessionService/)
  assert.equal(await detailWindow.evaluate(() => typeof window.panelNativeApi), 'undefined', 'a portal window does not bootstrap a second preload API or App')
  assert.equal(await electron.evaluate(({ app, BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'about:blank')
    try { app.panelTestManager.prepare(child.webContents, 'details'); return false } catch { return true }
  }), true, 'only the owning main renderer can prepare another window')
  await page.locator('.flow-inner-step.thinking').click()
  await detailWindow.waitForFunction(() => document.querySelector('.flow-detail-tabs button.active')?.textContent === '思考')
  assert.match(await detailWindow.locator('.flow-detail-body').innerText(), /两项审查可以独立进行/)
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    useAppStore.getState().setTheme('dark'); useAppStore.getState().setFontSize(18)
  })
  await detailWindow.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.documentElement.style.fontSize === '18px')
  await detailWindow.screenshot({ path: resolve(output, 'details-window-dark.png') })
  const ticket = await detailWindow.evaluate(() => window.name)
  assert.equal(await electron.evaluate(({ app, BrowserWindow }, key) => {
    const child = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'about:blank')
    return app.panelTestManager.control(child.webContents, key, 'close')
  }, ticket), false, 'a child cannot control its parent-owned window handle')
  await detailWindow.close()
  await page.waitForFunction(() => document.querySelector('.dock-details')?.dataset.mode === 'right')
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling()), true, 'the last auxiliary close restores the original throttling policy')
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false))
  assert.equal(await page.evaluate(key => window.open('about:blank', key) === null, ticket), true, 'closed window tickets cannot be replayed')

  const nextFlow = electron.waitForEvent('window')
  await page.locator('.dock-conversation').getByRole('button', { name: '在独立窗口打开', exact: true }).click()
  const flowWindow = await nextFlow
  observe(flowWindow)
  await flowWindow.locator('.react-flow').waitFor()
  await flowWindow.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await flowWindow.waitForFunction(() => document.querySelectorAll('.flow-card').length === 11)
  await settleViewport(flowWindow)
  const flowBounds = await flowWindow.locator('.flow-canvas').boundingBox()
  await flowWindow.mouse.move(flowBounds.x + flowBounds.width / 2, flowBounds.y + 24)
  const zoom = await flowWindow.evaluate(() => new DOMMatrix(document.querySelector('.react-flow__viewport').style.transform).a)
  await flowWindow.mouse.wheel(0, -240)
  await flowWindow.waitForFunction(previous => new DOMMatrix(document.querySelector('.react-flow__viewport').style.transform).a > previous, zoom)
  await page.evaluate(() => {
    flowUiFixture.emit('agent.onRunningChange', { sessionId: 'parent', running: true })
    flowUiFixture.emit('agent.onAssistantMessage', { sessionId: 'parent', messageId: 'native-live', phase: 'start', content: '', toolCalls: [] })
    flowUiFixture.emit('agent.onToken', { sessionId: 'parent', messageId: 'native-live', token: '独立窗口的实时输出' })
  })
  await flowWindow.getByRole('button', { name: '跟随运行', exact: true }).click()
  await assertFocusedNode(flowWindow, '独立窗口的实时输出')
  await flowWindow.getByRole('button', { name: '最新输出', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.flow-detail-body')?.textContent.includes('独立窗口的实时输出'))
  await flowWindow.screenshot({ path: resolve(output, 'flow-window-dark.png') })
  const anotherDetails = electron.waitForEvent('window')
  await page.locator('.dock-details').getByRole('button', { name: '在独立窗口打开', exact: true }).click()
  const secondDetails = await anotherDetails
  observe(secondDetails)
  await secondDetails.locator('.flow-inspector').waitFor()
  await assertStreamingDetail(page, secondDetails, 'native-live')
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 3)
  const security = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => {
    const preferences = window.webContents.getLastWebPreferences()
    return [preferences.contextIsolation, preferences.nodeIntegration]
  }))
  assert.ok(security.every(([isolated, node]) => isolated && !node))
  await secondDetails.getByRole('button', { name: '停靠回主窗口', exact: true }).click()
  await page.locator('.flow-inspector').waitFor()
  await setPanelMode(page, 'details', '窗口内浮动')
  await assertStreamingDetail(page, page, 'native-live')
  await setPanelMode(page, 'details', '停靠右侧')
  const livePreview = await flowWindow.locator('.flow-speech-text').filter({ hasText: '独立窗口的实时输出' }).textContent()
  await flowWindow.getByRole('button', { name: '停靠回主窗口', exact: true }).click()
  await page.locator('.flow-canvas').waitFor()
  await assertFocusedNode(page, livePreview)
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'return closes only auxiliary windows')
  await page.getByRole('button', { name: '适应画布', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.flow-card').length === 12)
  await page.screenshot({ path: resolve(output, 'docked-dark.png') })
  const teardownWindow = electron.waitForEvent('window')
  await page.locator('.dock-details').getByRole('button', { name: '在独立窗口打开', exact: true }).click()
  const lastDetails = await teardownWindow
  await lastDetails.locator('.flow-inspector').waitFor()
  await page.locator('.sidebar').getByText('浏览器任务', { exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.dock-details'))
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  await page.locator('.settings-page-title').waitFor()
  await assertWindowControlHitAreas(page, '.settings-page-title')
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    useAppStore.setState({ view: 'chat', activeSessionId: null })
  })
  await page.locator('.chat-view-empty').waitFor()
  await assertWindowControlHitAreas(page, '.chat-view-empty')
  await page.locator('.window-controls button').nth(1).click()
  await page.waitForFunction(() => document.querySelector('.window-controls button:nth-child(2)')?.getAttribute('aria-label') === '还原')
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), true)
  await page.locator('.window-controls button').nth(1).click()
  await page.waitForFunction(() => document.querySelector('.window-controls button:nth-child(2)')?.getAttribute('aria-label') === '最大化')
  await page.locator('.window-controls button').first().click()
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), true)
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
  await page.locator('.window-controls button').last().click()
  assert.equal(await electron.evaluate(({ BrowserWindow }) => { const owner = BrowserWindow.getAllWindows()[0]; return !owner.isDestroyed() && !owner.isVisible() }), true,
    'closing the main window still hides it without destroying the session owner')
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'unmounting a workspace cleans its auxiliary windows')
  // Packaged apps use file:// rather than the dev origin. The portal DOM remains accessible there too.
  const fileProbe = resolve(output, 'file-origin.html')
  await writeFile(fileProbe, '<!doctype html><html><body>Panel file origin test</body></html>')
  await page.goto(pathToFileURL(fileProbe).href)
  const fileWindowEvent = electron.waitForEvent('window')
  assert.equal(await page.evaluate(async () => {
    const ticket = await window.panelNativeApi.panels.prepare('details')
    const child = window.open('about:blank', ticket.key)
    if (!child) return false
    child.document.body.textContent = 'File origin portal works'
    return child.document.body.textContent === 'File origin portal works'
  }), true)
  const fileWindow = await fileWindowEvent
  await page.reload()
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'owner reload cleans its windows and one-use tickets')
  assert.equal(fileWindow.isClosed(), true)
  assert.deepEqual(errors, [])
  console.log(`Panel UI passed: dragging, four-side docks, floating/resize, real Electron windows, shared streaming/theme, return and security. Screenshots: ${output}`)
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

async function setPanelMode(page, id, name) {
  const panel = page.locator(`[data-panel="${id}"]`)
  await panel.locator('.dock-panel-menu summary').click()
  await page.locator(`[data-menu-panel="${id}"]`).getByRole('menuitem', { name, exact: true }).click()
}
