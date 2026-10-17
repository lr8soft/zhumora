import { EventEmitter } from 'node:events'

export const notifications = []
export const logs = []
export const dialogCalls = []
export let dialogResult = { canceled: true, filePaths: [] }
export let dialogError
export function setDialogResponse(result, error) { dialogResult = result; dialogError = error }
export function log(...args) { logs.push(args) }
export class Notification extends EventEmitter {
  static supported = true
  static isSupported() { return this.supported }
  constructor(options) { super(); this.options = options; this.shown = 0; this.closed = 0; notifications.push(this) }
  show() { this.shown++ }
  close() { this.closed++ }
}
export class Tray extends EventEmitter {
  setToolTip() {}
  setContextMenu() {}
  destroy() {}
}
export const Menu = { buildFromTemplate: items => items }
export const nativeImage = { createFromPath: () => ({ isEmpty: () => false }), createEmpty: () => ({}) }
async function showDialog(kind, args) {
  dialogCalls.push({ kind, args })
  if (dialogError) throw dialogError
  return dialogResult
}
export const dialog = {
  showOpenDialog: (...args) => showDialog('open', args),
  showSaveDialog: (...args) => showDialog('save', args)
}
