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
import type { BotPlatformRuntime } from './bot/contracts'
import { TelegramBotService } from './telegram/service'

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
  bots: readonly BotPlatformRuntime[]
  telegram: TelegramBotService
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
  return { tools: toolRegistry, permissions, bots: [telegram], telegram }
}
