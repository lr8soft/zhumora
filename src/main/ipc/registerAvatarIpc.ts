import { dialog, ipcMain, type BrowserWindow } from 'electron'
import type { AvatarCapabilities, AvatarSessionUpdate } from '../../shared/avatar'
import type { AppSettings } from '../../shared/types'
import * as db from '../store/db'
import type { AvatarWindowManager } from '../avatar/windowManager'

export function registerAvatarIpc(win: BrowserWindow, avatar: AvatarWindowManager): void {
  ipcMain.handle('avatar:import-model', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'VRM Avatar', extensions: ['vrm'] }]
    })
    if (result.canceled) return null
    return avatar.importModel(result.filePaths[0])
  })

  ipcMain.handle('avatar:import-animation', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'VRM Animation', extensions: ['vrma'] }]
    })
    if (result.canceled) return null
    return avatar.importAnimation(result.filePaths[0])
  })

  ipcMain.handle('avatar:session-set', (_event, sessionId: unknown, requested: AvatarSessionUpdate) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session id.')
    const session = db.getSession(sessionId)
    if (!session) throw new Error('Session not found.')
    const settings = db.getSettings()
    const enabled = requested?.enabled === true
    const modelId = enabled && typeof requested?.modelId === 'string' ? requested.modelId : null
    const model = modelId ? settings.avatarModels.find(candidate => candidate.id === modelId) : undefined
    if (enabled && !model) throw new Error('Select an imported Avatar model first.')

    db.updateSessionAvatar(sessionId, enabled, modelId)
    if (enabled && model) avatar.show(sessionId, model)
    else avatar.hide(sessionId)
    return db.getSession(sessionId)
  })

  ipcMain.handle('avatar:bootstrap', event => avatar.getBootstrap(event.sender.id))
  ipcMain.handle('avatar:asset', (event, assetId: unknown) => {
    if (typeof assetId !== 'string' || !assetId) throw new Error('Invalid Avatar asset id.')
    return avatar.getAsset(event.sender.id, assetId)
  })
  ipcMain.handle('avatar:capabilities', (event, capabilities: AvatarCapabilities) => {
    avatar.reportCapabilities(event.sender.id, capabilities)
    return true
  })
  ipcMain.handle('avatar:command-result', (event, commandId: unknown, error?: unknown) => {
    if (typeof commandId !== 'string' || !commandId) throw new Error('Invalid Avatar command id.')
    avatar.resolveCommand(event.sender.id, commandId, typeof error === 'string' ? error : undefined)
    return true
  })
}

export function reconcileAvatarSessions(avatar: AvatarWindowManager, settings: AppSettings): void {
  const fallback = settings.defaultAvatarModelId || settings.avatarModels[0]?.id || null
  const sessions = db.getSessions()
  for (const session of sessions) {
    if (!session.avatarEnabled) continue
    const selectedExists = !!session.avatarModelId
      && settings.avatarModels.some(model => model.id === session.avatarModelId)
    if (selectedExists) continue
    db.updateSessionAvatar(session.id, fallback !== null, fallback)
  }
  avatar.syncSessions(db.getSessions(), settings)
}
