import { contextBridge, ipcRenderer } from 'electron'
import type { AvatarActivity, AvatarBootstrap, AvatarCapabilities, AvatarCommandEnvelope, AvatarLookTarget } from '../shared/avatar'
import type { AvatarDragPhase } from '../shared/avatarWindow'

const avatarApi = {
  drag: (phase: AvatarDragPhase): Promise<boolean> => ipcRenderer.invoke('avatar:drag', phase),
  onActivity: (callback: (activity: AvatarActivity) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, activity: AvatarActivity) => callback(activity)
    ipcRenderer.on('avatar:activity', handler)
    return () => ipcRenderer.removeListener('avatar:activity', handler)
  },
  getBootstrap: (): Promise<AvatarBootstrap> => ipcRenderer.invoke('avatar:bootstrap'),
  getAsset: (assetId: string): Promise<Uint8Array> => ipcRenderer.invoke('avatar:asset', assetId),
  reportCapabilities: (capabilities: AvatarCapabilities): Promise<boolean> =>
    ipcRenderer.invoke('avatar:capabilities', capabilities),
  reportCommandResult: (commandId: string, error?: string): Promise<boolean> =>
    ipcRenderer.invoke('avatar:command-result', commandId, error),
  setPointerPassthrough: (passthrough: boolean): Promise<boolean> =>
    ipcRenderer.invoke('avatar:pointer-passthrough', passthrough),
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
  },
  onLookTarget: (callback: (target: AvatarLookTarget) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, target: AvatarLookTarget) => callback(target)
    ipcRenderer.on('avatar:look-target', handler)
    return () => ipcRenderer.removeListener('avatar:look-target', handler)
  }
}

export type AvatarRendererAPI = typeof avatarApi
contextBridge.exposeInMainWorld('avatarApi', avatarApi)
