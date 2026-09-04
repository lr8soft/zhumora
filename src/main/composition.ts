// Application composition root. Construct process-wide adapters here; feature
// modules must not register infrastructure as a side effect of IPC setup.
import { builtinTools } from './tools/builtin'
import { browserTools } from './tools/browser'
import { memoryTools } from './tools/memory'
import { desktopTools } from './tools/desktop'
import { officeTools } from './tools/officeTool'
import { mcpManagerTools } from './mcp/managerTools'
import { toolRegistry, type ToolHandler, type ToolRegistry } from './tools/registry'
import * as db from './store/db'
import { getMcpConnectionStatus } from './mcp/client'
import { getSkillsSystemPrompt } from './skill/manager'
import { PermissionBroker } from './agent/permissionBroker'
import { BotAgentBridge } from './bot/agentBridge'
import { BotPlatformManager, defineBotPlatform } from './bot/platformManager'
import { TelegramBotService } from './telegram/service'
import { equivalentTelegramBotConfig, normalizeTelegramBotConfig } from '../shared/telegram'
import { equivalentQQBotConfig, normalizeQQBotConfig } from '../shared/qq'
import { QQBotService } from './qq/service'
import { getFetch } from './net/fetch'

const builtinGroups: ReadonlyArray<ReadonlyArray<{ name: string; handler: ToolHandler }>> = [
  builtinTools,
  browserTools,
  memoryTools,
  desktopTools,
  mcpManagerTools,
  officeTools
]

export interface ApplicationServices {
  tools: ToolRegistry
  permissions: PermissionBroker
  bots: BotPlatformManager
}

export function createApplicationServices(): ApplicationServices {
  toolRegistry.clear()
  for (const group of builtinGroups) {
    for (const { name, handler } of group) toolRegistry.register(name, handler, 'builtin')
  }
  const permissions = new PermissionBroker()
  const botAgent = new BotAgentBridge({
    tools: toolRegistry,
    permissions,
    store: db,
    getSkillsPrompt: getSkillsSystemPrompt,
    getMcpStatus: getMcpConnectionStatus
  })
  const telegram = new TelegramBotService(botAgent, permissions)
  const qq = new QQBotService(botAgent, permissions, { getFetch })
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
  return { tools: toolRegistry, permissions, bots }
}
