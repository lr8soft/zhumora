import { contextBridge, ipcRenderer } from 'electron'
import type { AvatarBootstrap, AvatarCapabilities, AvatarCommandEnvelope } from '../shared/avatar'

const avatarApi = {
  getBootstrap: (): Promise<AvatarBootstrap> => ipcRenderer.invoke('avatar:bootstrap'),
  getAsset: (assetId: string): Promise<Uint8Array> => ipcRenderer.invoke('avatar:asset', assetId),
  reportCapabilities: (capabilities: AvatarCapabilities): Promise<boolean> =>
    ipcRenderer.invoke('avatar:capabilities', capabilities),
  reportCommandResult: (commandId: string, error?: string): Promise<boolean> =>
    ipcRenderer.invoke('avatar:command-result', commandId, error),
  onStateChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('avatar:state-changed', handler)
    return () => ipcRenderer.removeListener('avatar:state-changed', handler)
  },
  onCommand: (callback: (envelope: AvatarCommandEnvelope) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, envelope: AvatarCommandEnvelope) => callback(envelope)
    ipcRenderer.on('avatar:command', handler)
    return () => ipcRenderer.removeListener('avatar:command', handler)
  },
  onMessage: (callback: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
    ipcRenderer.on('avatar:message', handler)
    return () => ipcRenderer.removeListener('avatar:message', handler)
  }
}

export type AvatarRendererAPI = typeof avatarApi
contextBridge.exposeInMainWorld('avatarApi', avatarApi)
