import { contextBridge, ipcRenderer } from 'electron'
import type { PanelId, PanelWindowAction, PanelWindowTicket } from '../../src/shared/panels'
contextBridge.exposeInMainWorld('panelNativeApi', { window: {
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
  close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange: (cb: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => cb(maximized)
    ipcRenderer.on('window:maximized-change', handler)
    return () => ipcRenderer.removeListener('window:maximized-change', handler)
  }
}, panels: {
  prepare: (id: PanelId): Promise<PanelWindowTicket> => ipcRenderer.invoke('panels:prepare', id),
  control: (key: string, action: PanelWindowAction) => ipcRenderer.invoke('panels:control', key, action),
  onClosed: (cb: (event: { key: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { key: string }) => cb(payload)
    ipcRenderer.on('panels:closed', listener)
    return () => ipcRenderer.removeListener('panels:closed', listener)
  }
} })
