import { app, BrowserWindow, ipcMain } from 'electron'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { PanelWindowManager } from '../../src/main/panels/windowManager'
import { registerPanelIpc } from '../../src/main/ipc/registerPanelIpc'

const testData = resolve(__dirname, `user-data-${process.pid}`)
mkdirSync(testData, { recursive: true })
app.setPath('userData', testData)
app.setPath('sessionData', testData)
app.disableHardwareAcceleration()
app.whenReady().then(() => {
  const panels = new PanelWindowManager(false)
  Object.defineProperty(app, 'panelTestManager', { value: panels })
  const owner = new BrowserWindow({ show: false, frame: false, width: 1600, height: 1000, webPreferences: {
    preload: resolve(__dirname, 'preload.cjs'), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
  } })
  const lifetime = { quitting: false }
  owner.on('close', event => { if (!lifetime.quitting) { event.preventDefault(); owner.hide() } })
  app.on('before-quit', () => { lifetime.quitting = true })
  ipcMain.handle('window:minimize', () => owner.minimize())
  ipcMain.handle('window:toggle-maximize', () => {
    if (owner.isMaximized()) owner.unmaximize()
    else owner.maximize()
    return owner.isMaximized()
  })
  ipcMain.handle('window:close', () => owner.close())
  ipcMain.handle('window:is-maximized', () => owner.isMaximized())
  owner.on('maximize', () => owner.webContents.send('window:maximized-change', true))
  owner.on('unmaximize', () => owner.webContents.send('window:maximized-change', false))
  panels.attach(owner)
  registerPanelIpc(panels)
  owner.webContents.setWindowOpenHandler(details => panels.allow(owner.webContents, details) ?? { action: 'deny' })
  void owner.loadURL('about:blank')
  app.on('before-quit', () => panels.dispose())
})
