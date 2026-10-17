import assert from 'node:assert/strict'
import { register } from 'node:module'
import type { BrowserWindow } from 'electron'
import type { AgentEventSink } from '../src/main/agent/persistedCallbacks.ts'
import type { PermissionBroker } from '../src/main/agent/permissionBroker.ts'
import { Notification, notifications, logs, dialogCalls, setDialogResponse } from './helpers/windowAdaptersFixture.mjs'

register('./helpers/windowAdaptersLoader.mjs', import.meta.url)
const { BackgroundManager } = await import('../src/main/background.ts')
const { showOpenDialogForWindow, showSaveDialogForWindow } = await import('../src/main/ipc/dialogs.ts')

let visible = true, destroyed = false, minimized = false
let shows = 0, focuses = 0, restores = 0, visibilityReads = 0
const win = {
  isDestroyed: () => destroyed, isVisible: () => { visibilityReads++; return visible },
  isMinimized: () => minimized, restore: () => { restores++ },
  show: () => { shows++ }, focus: () => { focuses++ }
}
const parent = win as BrowserWindow
const openOptions = { properties: ['openFile' as const], filters: [{ name: 'VRM', extensions: ['vrm'] }] }
const saveOptions = { defaultPath: 'diagram.png', filters: [{ name: 'PNG', extensions: ['png'] }] }
for (const state of ['visible', 'hidden', 'destroyed']) {
  visible = state === 'visible'; destroyed = state === 'destroyed'
  const reads = visibilityReads
  const result = { canceled: false, filePaths: ['chosen.vrm'], filePath: 'chosen.png' }
  setDialogResponse(result)
  assert.equal(await showOpenDialogForWindow(parent, openOptions), result)
  assert.equal(await showSaveDialogForWindow(parent, saveOptions), result)
  for (const [call, options] of [[dialogCalls.at(-2), openOptions], [dialogCalls.at(-1), saveOptions]] as const) {
    assert.deepEqual(call.args, state === 'visible' ? [parent, options] : [options])
    assert.equal(call.args.at(-1), options, 'filters/options must pass through unchanged')
  }
  if (destroyed) assert.equal(visibilityReads, reads, 'do not inspect visibility on destroyed windows')
}
setDialogResponse({ canceled: true, filePaths: [] })
assert.equal((await showOpenDialogForWindow(parent, openOptions)).canceled, true)
const failure = new Error('native dialog failed')
setDialogResponse(undefined, failure)
await assert.rejects(showSaveDialogForWindow(parent, saveOptions), error => error === failure)

let sink: AgentEventSink = {}
let permissionChanged: Parameters<PermissionBroker['addObserver']>[0] = () => {}
let eventUnsubscribed = false, observerUnsubscribed = false
const manager = new BackgroundManager({
  subscribeEvents: next => { sink = next; return () => { eventUnsubscribed = true } },
  permissions: { addObserver: observer => { permissionChanged = observer; return () => { observerUnsubscribed = true } } },
  getSessionTitle: id => id, getLanguage: () => 'en', getMainWindow: () => win,
  trayIconPath: 'icon-32.png', quitApp: () => { throw new Error('notification must not quit app') }
})
try {
  destroyed = false; visible = true
  sink.complete?.('visible', 'm', 'done')
  permissionChanged('visible', true)
  assert.equal(notifications.length, 0, 'visible window does not get background notifications')
  visible = false
  permissionChanged('pending', true)
  const pending = notifications.at(-1)!
  assert.equal(pending.options.icon, 'icon-32.png')
  assert.equal(pending.shown, 1)
  pending.emit('failed', { marker: 'event object' }, 'native toast failure')
  assert.deepEqual(logs.at(-1), ['warn', 'Background notification failed: native toast failure'])
  assert.equal(pending.closed, 0, 'notification failure does not settle pending permission')
  permissionChanged('pending', true)
  assert.equal(notifications.length, 1, 'still-pending permission is not notified twice')
  minimized = true
  pending.emit('click')
  assert.deepEqual([restores, shows, focuses], [1, 1, 1])
  permissionChanged('pending', false)
  assert.equal(pending.closed, 1)
  sink.complete?.('finished', 'm', 'done')
  sink.error?.('failed', new Error('run failed'))
  assert.equal(notifications.length, 3, 'run completion/error notifications remain separate')
  Notification.supported = false
  sink.complete?.('unsupported', 'm', 'done')
  permissionChanged('unsupported', true)
  assert.equal(notifications.length, 3)
  Notification.supported = true
  permissionChanged('dispose', true)
  const leftover = notifications.at(-1)!
  manager.dispose()
  assert.equal(leftover.closed, 1)
  assert.ok(eventUnsubscribed && observerUnsubscribed)
} finally { Notification.supported = true }
console.log('Window adapters: native dialog overloads, failures, notification lifecycle and permission isolation passed')
