import { ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import type { AppSettings } from '../../shared/types'
import * as db from '../store/db'
import { fetchContextWindow } from '../agent/context'
import { listProviderModels } from '../llm/models'
import { connectMcpServer, disconnectMcpServer, reconnectAllMcpServers } from '../mcp/client'
import { reloadSkills } from '../skill/manager'
import { logCertModeChanged } from '../net/fetch'
import { equivalentConfigList } from './settingsChange'
import type { ApplicationServices } from '../composition'
import type { AgentIpcRuntime } from './runtime'

export function registerGeneralIpc(win: BrowserWindow, runtime: AgentIpcRuntime, services: ApplicationServices): void {
  ipcMain.handle('window:minimize', () => win.minimize())
  ipcMain.handle('window:toggle-maximize', () => {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', () => win.close())
  ipcMain.handle('window:is-maximized', () => win.isMaximized())
  win.on('maximize', () => win.webContents.send('window:maximized-change', true))
  win.on('unmaximize', () => win.webContents.send('window:maximized-change', false))

  ipcMain.handle('session:create', (_event, title?: string) => db.createSession(title))
  ipcMain.handle('session:list', () => db.getSessions())
  ipcMain.handle('session:get', (_event, id: string) => db.getSession(id))
  ipcMain.handle('session:delete', (_event, id: string) => {
    services.permissions.cancelSession(id)
    db.deleteSession(id)
    runtime.deleteSession(id)
    return true
  })
  ipcMain.handle('session:rename', (_event, id: string, title: string) => {
    db.updateSessionTitle(id, title)
    return true
  })
  ipcMain.handle('session:messages', (_event, id: string) => db.getMessages(id))
  ipcMain.handle('session:compaction', (_event, id: string) => db.getSessionCompaction(id))
  ipcMain.handle('session:updateWorkspace', (_event, id: string, workspacePath: string) => {
    db.updateSessionWorkspace(id, workspacePath)
    return true
  })

  ipcMain.handle('settings:get', () => db.getSettings())
  ipcMain.handle('settings:save', async (_event, requested: AppSettings) => {
    const previous = db.getSettings()
    db.saveSettings(requested)
    const settings = db.getSettings()
    const mcpChanged = !equivalentConfigList(settings.mcpServers, previous.mcpServers)
    const skillsChanged = !equivalentConfigList(settings.skills, previous.skills)
    const certModeChanged = (settings.useSystemCerts === true) !== (previous.useSystemCerts === true)

    if (skillsChanged) {
      try {
        await reloadSkills(settings.skills)
      } catch (error) {
        console.error('Skills reload error:', error)
      }
    }
    if (certModeChanged) logCertModeChanged(settings.useSystemCerts === true)
    if (mcpChanged || (certModeChanged && settings.mcpServers.some(server => server.enabled && server.type !== 'stdio'))) {
      try {
        await reconnectAllMcpServers(settings.mcpServers)
      } catch (error) {
        console.error('MCP reconnect error:', error)
      }
    }
    void services.bots.applySettings(settings, previous, certModeChanged).catch(error => {
      console.error('Bot platform reconfigure error:', error)
    })
    return true
  })
  ipcMain.handle('settings:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('settings:pickFile', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Skill files', extensions: ['md'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    void shell.openExternal(url)
    return true
  })

  ipcMain.handle('token:summary', () => db.getTokenUsageSummary())
  ipcMain.handle('token:buckets', (_event, days?: number) => db.getTokenUsageBuckets(days || 7))
  ipcMain.handle('bot:test', async (_event, channel: unknown, config: unknown) => {
    if (typeof channel !== 'string' || !channel) return { error: 'Invalid Bot platform.' }
    try {
      return { ok: true, bot: await services.bots.test(channel, config) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('provider:context-window', async (_event, provider: AppSettings['providers'][0], modelOverride?: string) => {
    try {
      return { detected: await fetchContextWindow(provider, modelOverride) }
    } catch (error) {
      return { error: (error as Error).message }
    }
  })
  ipcMain.handle('provider:models', (_event, provider: AppSettings['providers'][0], force?: boolean) =>
    listProviderModels(provider, force === true))

  ipcMain.handle('memory:list', (_event, options?: { category?: string; search?: string; limit?: number }) =>
    db.getMemories({ category: options?.category as any, search: options?.search, limit: options?.limit }))
  ipcMain.handle('memory:delete', (_event, id: string) => {
    db.deleteMemory(id)
    return true
  })
  ipcMain.handle('memory:clearAll', () => {
    db.clearAllMemories()
    return true
  })
  ipcMain.handle('memory:updateImportance', (_event, id: string, importance: number) => {
    db.updateMemoryImportance(id, importance)
    return true
  })

  ipcMain.handle('mcp:connect', async (_event, config) => {
    try {
      await connectMcpServer(config)
      return { ok: true }
    } catch (error) {
      return { error: (error as Error).message }
    }
  })
  ipcMain.handle('mcp:disconnect', async (_event, id: string) => {
    await disconnectMcpServer(id)
    return true
  })
}
