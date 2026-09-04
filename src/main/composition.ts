// Application composition root. Construct process-wide adapters here; feature
// modules must not register infrastructure as a side effect of IPC setup.
import { builtinTools } from './tools/builtin'
import { browserTools } from './tools/browser'
import { memoryTools } from './tools/memory'
import { desktopTools } from './tools/desktop'
import { officeTools } from './tools/officeTool'
import { mcpManagerTools } from './mcp/managerTools'
import { toolRegistry, type ToolHandler, type ToolRegistry } from './tools/registry'
import { TelegramAgentBridge } from './telegram/agentBridge'
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
  telegram: TelegramBotService
}

export function createApplicationServices(): ApplicationServices {
  toolRegistry.clear()
  for (const group of builtinGroups) {
    for (const { name, handler } of group) toolRegistry.register(name, handler, 'builtin')
  }
  const telegram = new TelegramBotService(new TelegramAgentBridge(toolRegistry))
  return { tools: toolRegistry, telegram }
}
