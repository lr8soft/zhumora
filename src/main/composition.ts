// Application composition root. Construct process-wide adapters here; feature
// modules must not register infrastructure as a side effect of IPC setup.
import { builtinTools } from './tools/builtin'
import { browserTools } from './tools/browser'
import { memoryTools } from './tools/memory'
import { createDesktopTools } from './tools/desktop'
import { DesktopControlCoordinator } from './desktop/controlCoordinator'
import { DesktopControlOverlay } from './desktop/controlOverlay'
import { officeTools } from './tools/officeTool'
import { mcpManagerTools } from './mcp/managerTools'
import { createBbsClient } from './bbs/client'
import { bbsSystemPromptHint, createBbsTools } from './bbs/tools'
import { toolRegistry, type ToolHandler, type ToolRegistry } from './tools/registry'
import * as db from './store/db'
import { getMcpConnectionStatus } from './mcp/client'
import { getSkillsSystemPrompt } from './skill/manager'
import { PermissionBroker } from './agent/permissionBroker'
import { SessionService } from './agent/sessionService'
import { runAgent } from './agent/runner'
import { fetchContextWindow, planAutoCompact } from './agent/context'
import { complete } from './llm/provider'
import { log } from './llm/logger'
import { BotSessionAdapter } from './bot/sessionAdapter'
import { BotPlatformManager, defineBotPlatform } from './bot/platformManager'
import { TelegramBotService } from './telegram/service'
import { equivalentTelegramBotConfig, normalizeTelegramBotConfig } from '../shared/telegram'
import { equivalentQQBotConfig, normalizeQQBotConfig } from '../shared/qq'
import { QQBotService } from './qq/service'
import { getFetch } from './net/fetch'
import type { AvatarWindowManager } from './avatar/windowManager'
import { createAvatarTools } from './tools/avatar'
import { TtsManager } from './tts/manager'
import { McpServerManager } from './mcpServer/server'

const builtinGroups: ReadonlyArray<ReadonlyArray<{ name: string; handler: ToolHandler }>> = [
  builtinTools,
  browserTools,
  memoryTools,
  mcpManagerTools,
  officeTools
]

export interface ApplicationServices {
  tools: ToolRegistry
  permissions: PermissionBroker
  sessions: SessionService
  bots: BotPlatformManager
  /** 对外 MCP 服务器（入站）：外部编排器把 Zhumora 当协作者。 */
  mcpServer: McpServerManager
  avatar: AvatarWindowManager
  tts: TtsManager
  desktopControl: DesktopControlCoordinator
}

export function createApplicationServices(avatar: AvatarWindowManager): ApplicationServices {
  toolRegistry.clear()
  const desktopControl = new DesktopControlCoordinator(new DesktopControlOverlay(id => db.getSession(id)?.title || '当前会话'))
  // BBS 工具无自身生命周期：配置（token/开关/地址）与 fetch 每次调用时现读
  // （settings 保存即生效；系统证书开关切换也即时生效），无需重连或重启。
  const bbsGetConfig = () => db.getSettings().bbs
  const bbsClient = createBbsClient({ getConfig: bbsGetConfig, getFetch })
  const bbsTools = createBbsTools({ client: bbsClient, getConfig: bbsGetConfig })
  for (const group of [...builtinGroups, createAvatarTools(avatar), createDesktopTools(desktopControl), bbsTools]) {
    for (const { name, handler } of group) toolRegistry.register(name, handler, 'builtin')
  }
  const permissions = new PermissionBroker()
  const tts = new TtsManager(db)
  const sessions = new SessionService({
    tools: toolRegistry,
    permissions,
    store: db,
    getSkillsPrompt: getSkillsSystemPrompt,
    getMcpStatus: getMcpConnectionStatus,
    // 系统提示词扩展 = Avatar 能力声明 + BBS 讨论区指引（后者仅在配置可用时非空）。
    // 每轮现读 settings：保存设置后下一轮即生效，无需重启。
    getSystemPromptExtra: async sessionId => {
      const avatarPrompt = await avatar.buildSystemPrompt(sessionId)
      const bbsPrompt = bbsSystemPromptHint(db.getSettings().bbs) || ''
      return [avatarPrompt, bbsPrompt].filter(Boolean).join('\n\n')
    },
    executeAgent: runAgent,
    fetchContextWindow,
    planAutoCompact,
    completeText: complete,
    log
  })
  const botSessions = new BotSessionAdapter({ sessions })
  const mcpServer = new McpServerManager(sessions, botSessions, permissions, toolRegistry, db.getSettings().mcpServer)
  const telegram = new TelegramBotService(botSessions, permissions)
  const qq = new QQBotService(botSessions, permissions, { getFetch })
  const bots = new BotPlatformManager([
    defineBotPlatform({
      service: telegram,
      selectConfig: settings => settings.telegramBot,
      normalizeConfig: normalizeTelegramBotConfig,
      equivalentConfig: equivalentTelegramBotConfig,
      test: config => telegram.test(config)
    }),
    defineBotPlatform({
      service: qq,
      selectConfig: settings => settings.qqBot,
      normalizeConfig: normalizeQQBotConfig,
      equivalentConfig: equivalentQQBotConfig,
      test: config => qq.test(config)
    })
  ])
  return { tools: toolRegistry, permissions, sessions, bots, mcpServer, avatar, tts, desktopControl }
}
