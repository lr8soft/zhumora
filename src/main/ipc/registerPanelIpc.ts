import { ipcMain } from 'electron'
import type { PanelWindowManager } from '../panels/windowManager'

export function registerPanelIpc(panels: PanelWindowManager): void {
  ipcMain.handle('panels:prepare', (event, panelId: unknown) => panels.prepare(event.sender, panelId))
  ipcMain.handle('panels:control', (event, key: unknown, action: unknown) => panels.control(event.sender, key, action))
}
