import { app, BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { PanelWindowManager } from '../../src/main/panels/windowManager'
import { registerPanelIpc } from '../../src/main/ipc/registerPanelIpc'

const testData = resolve(`.temp/panel-ui/user-data-${process.pid}`)
mkdirSync(testData, { recursive: true })
app.setPath('userData', testData)
app.setPath('sessionData', testData)
app.disableHardwareAcceleration()
app.whenReady().then(() => {
  const panels = new PanelWindowManager(false)
  Object.defineProperty(app, 'panelTestManager', { value: panels })
  const owner = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: {
    preload: resolve('.temp/panel-ui/preload.cjs'), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
  } })
  panels.attach(owner)
  registerPanelIpc(panels)
  owner.webContents.setWindowOpenHandler(details => panels.allow(owner.webContents, details) ?? { action: 'deny' })
  void owner.loadURL('about:blank')
  app.on('before-quit', () => panels.dispose())
})
