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
  avatar: AvatarWindowManager
  tts: TtsManager
  desktopControl: DesktopControlCoordinator
}

export function createApplicationServices(avatar: AvatarWindowManager): ApplicationServices {
  toolRegistry.clear()
  const desktopControl = new DesktopControlCoordinator(new DesktopControlOverlay(id => db.getSession(id)?.title || '当前会话'))
  for (const group of [...builtinGroups, createAvatarTools(avatar), createDesktopTools(desktopControl)]) {
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
    getSystemPromptExtra: sessionId => avatar.buildSystemPrompt(sessionId),
    executeAgent: runAgent,
    fetchContextWindow,
    planAutoCompact,
    completeText: complete,
    log
  })
  const botSessions = new BotSessionAdapter({ sessions })
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
  return { tools: toolRegistry, permissions, sessions, bots, avatar, tts, desktopControl }
}
