import { ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import { promises as fsPromises } from 'node:fs'
import type { AppSettings } from '../../shared/types'
import * as db from '../store/db'
import { detectProviderContextWindow } from '../agent/context'
import { shouldApplyDetectedContextWindow } from '../agent/contextDetectionPolicy'
import { listProviderModels } from '../llm/models'
import { probeReasoningCapability } from '../llm/reasoningCapability'
import { connectMcpServer, disconnectMcpServer, reconnectAllMcpServers } from '../mcp/client'
import { reloadSkills, inspectSkillPath, type SkillInspection } from '../skill/manager'
import { refreshSkillTool } from '../skill/skillTool'
import { getFetch, logCertModeChanged } from '../net/fetch'
import { createBbsClient } from '../bbs/client'
import { normalizeBbsConfig } from '../../shared/bbs'
import type { BbsConfig } from '../../shared/bbs'
import { equivalentConfigList } from './settingsChange'
import type { ApplicationServices } from '../composition'
import { reconcileAvatarSessions } from './registerAvatarIpc'

/** 图表导出保存对话框的格式过滤器（按 renderer 已选 format 收窄，避免误导用户）。 */
const DIAGRAM_SAVE_FILTERS: Record<'png' | 'jpeg', { name: string; extensions: string[] }> = {
  png: { name: 'PNG Image', extensions: ['png'] },
  jpeg: { name: 'JPEG Image', extensions: ['jpeg', 'jpg'] }
}

export function registerGeneralIpc(win: BrowserWindow, services: ApplicationServices): void {
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

  ipcMain.handle('session:create', (_event, title?: string) => services.sessions.createSession(title))
  ipcMain.handle('session:list', () => services.sessions.listSessions())
  ipcMain.handle('session:get', (_event, id: string) => services.sessions.getSession(id))
  ipcMain.handle('session:delete', async (_event, id: string) => {
    services.avatar.hide(id)
    services.tts.stop(id)
    await services.sessions.deleteSession(id)
    return true
  })
  ipcMain.handle('session:rename', (_event, id: string, title: string) => {
    services.sessions.renameSession(id, title)
    return true
  })
  ipcMain.handle('session:messages', (_event, id: string) => services.sessions.getMessages(id))
  ipcMain.handle('session:compaction', (_event, id: string) => services.sessions.getCompaction(id))
  ipcMain.handle('session:updateWorkspace', (_event, id: string, workspacePath: string) => {
    services.sessions.updateWorkspace(id, workspacePath)
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
        refreshSkillTool()
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
    void services.mcpServer.applySettings(settings, previous).catch(error => {
      console.error('MCP server reconfigure error:', error)
    })
    await services.avatar.applySettings(settings, previous)
    services.tts.applySettings(settings, previous)
    reconcileAvatarSessions(services.avatar, settings)
    return settings
  })
  // 窗口隐藏（后台运行）时打开原生对话框会挂起进程事件循环，
  // 统一回落到无父窗口对话框（仍保持模态但不依赖主窗口可见性）
  const dialogParent = () => (win.isDestroyed() || !win.isVisible() ? undefined : win)
  ipcMain.handle('settings:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(dialogParent(), { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('settings:pickFile', async () => {
    const result = await dialog.showOpenDialog(dialogParent(), {
      properties: ['openFile'],
      filters: [{ name: 'Skill files', extensions: ['md'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  /** 添加 Skill 前校验路径（目录含 SKILL.md 或单个 .md 文件，frontmatter 合规）。 */
  ipcMain.handle('skill:inspectPath', async (_event, p: unknown): Promise<SkillInspection | null> => {
    if (typeof p !== 'string' || !p) return null
    return inspectSkillPath(p)
  })
  /** 保存 Mermaid 图表为位图文件（PNG / JPEG）：content 是 dataURL（光栅化在 renderer 完成），解码为 Buffer 写入。
   *  独立 SVG 导出已移除（落盘文件历史上频繁解析失败）；文件名一律取用户选择的路径，避免 dataURL 被当成文件名。 */
  ipcMain.handle('settings:saveDiagram', async (_event, content: unknown, format: unknown, defaultPath: unknown) => {
    if (typeof content !== 'string' || !content) return 'failed'
    if (format !== 'png' && format !== 'jpeg') return 'failed'
    const dataUrl = /^data:image\/(png|jpeg);base64,/.exec(content)?.[0]
    if (!dataUrl) return 'failed'
    const defaultName = typeof defaultPath === 'string' && defaultPath ? defaultPath : `diagram.${format}`
    // 保存对话框的格式下拉只展示用户已选格式（内容写入只认 format，列全格式只会误导用户）
    const result = await dialog.showSaveDialog(dialogParent(), {
      title: 'Save Diagram',
      defaultPath: defaultName,
      filters: [DIAGRAM_SAVE_FILTERS[format]]
    })
    if (result.canceled || !result.filePath) return 'canceled'
    try {
      await fsPromises.writeFile(result.filePath, Buffer.from(content.slice(dataUrl.length), 'base64'))
      return 'saved'
    } catch (error) {
      console.error('Save diagram error:', error)
      return 'failed'
    }
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
  ipcMain.handle('provider:context-window', async (_event, provider: AppSettings['providers'][0], modelOverride?: string, requested?: boolean) => {
    try {
      const detected = await detectProviderContextWindow(provider, modelOverride)
      // 显式手动值优先于探测（TECHNICAL.md）：非用户显式请求时不覆盖已配置值
      if (!shouldApplyDetectedContextWindow(provider, requested === true)) return {}
      return { detected }
    } catch (error) {
      return { error: (error as Error).message }
    }
  })
  ipcMain.handle('provider:models', (_event, provider: AppSettings['providers'][0], force?: boolean) =>
    listProviderModels(provider, force === true))
  /** 探测端点是否声明接受"思考强度"参数（llama.cpp /props 的 chat_template_caps）。
   *  只用于设置页如实展示；不落库、不参与运行路径，探测失败返回"未声明"。 */
  ipcMain.handle('provider:reasoning-capability', (_event, provider: AppSettings['providers'][0], modelOverride?: string) =>
    probeReasoningCapability(provider, modelOverride))

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

  // 对外 MCP 服务器（入站）状态：只读，不触发任何重连。
  ipcMain.handle('mcpServer:status', () => services.mcpServer.status())

  // ============================================================
  // Zhumora BBS（讨论区）— 设置页的探测/注册入口
  // 全部用"未保存草稿"配置发请求（与 bot:test 语义一致）；
  // token 只由设置页写回草稿，保存时才落库。
  // ============================================================
  /** 把 renderer 传入的草稿配置封装成探测客户端（未保存也能测） */
  const bbsProbeFor = (draft: BbsConfig) => createBbsClient({ getConfig: () => draft, getFetch })

  ipcMain.handle('bbs:health', async (_event, baseUrl: unknown) => {
    const raw = typeof baseUrl === 'string' ? baseUrl.trim() : ''
    if (!raw) return { ok: false, error: '请先填写服务器地址' }
    const base = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`
    return { ok: await bbsProbeFor({ ...normalizeBbsConfig(db.getSettings().bbs), baseUrl: base }).health() }
  })
  ipcMain.handle('bbs:register', async (_event, draft: unknown, username: unknown, password: unknown, displayName: unknown) => {
    const config = normalizeBbsConfig(draft)
    const name = typeof username === 'string' ? username.trim() : ''
    const pass = typeof password === 'string' ? password : ''
    if (!name) return { error: '请输入用户名' }
    if (pass.length < 8) return { error: '密码至少 8 位' }
    return bbsProbeFor(config).register(name, pass, typeof displayName === 'string' ? displayName : undefined)
  })
  ipcMain.handle('bbs:login', async (_event, draft: unknown, username: unknown, password: unknown) => {
    const config = normalizeBbsConfig(draft)
    const name = typeof username === 'string' ? username.trim() : ''
    const pass = typeof password === 'string' ? password : ''
    if (!name) return { error: '请输入用户名' }
    return bbsProbeFor(config).login(name, pass)
  })
  ipcMain.handle('bbs:me', async (_event, draft: unknown) => {
    const config = normalizeBbsConfig(draft)
    if (!config.baseUrl || !config.token) return { error: '请先填写服务器地址并注册账号' }
    try {
      return { profile: await bbsProbeFor(config).me() }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
}
