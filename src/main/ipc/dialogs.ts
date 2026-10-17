import { dialog, type BrowserWindow, type OpenDialogOptions, type SaveDialogOptions } from 'electron'

// Hidden/destroyed windows must not own a native modal dialog. Select the actual
// Electron overload instead of passing undefined as its parent-window argument.
export function showOpenDialogForWindow(win: BrowserWindow, options: OpenDialogOptions) {
  return !win.isDestroyed() && win.isVisible()
    ? dialog.showOpenDialog(win, options)
    : dialog.showOpenDialog(options)
}

export function showSaveDialogForWindow(win: BrowserWindow, options: SaveDialogOptions) {
  return !win.isDestroyed() && win.isVisible()
    ? dialog.showSaveDialog(win, options)
    : dialog.showSaveDialog(options)
}
