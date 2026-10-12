import { contextBridge, ipcRenderer } from 'electron'
import type { PanelId, PanelWindowAction, PanelWindowTicket } from '../../src/shared/panels'
contextBridge.exposeInMainWorld('panelNativeApi', { panels: {
  prepare: (id: PanelId): Promise<PanelWindowTicket> => ipcRenderer.invoke('panels:prepare', id),
  control: (key: string, action: PanelWindowAction) => ipcRenderer.invoke('panels:control', key, action),
  onClosed: (cb: (event: { key: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { key: string }) => cb(payload)
    ipcRenderer.on('panels:closed', listener)
    return () => ipcRenderer.removeListener('panels:closed', listener)
  }
} })
