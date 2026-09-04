import type { ToolCall, UIMessage } from '../../shared/types'
import { AgentAbortedError } from '../../shared/types'
import { runAgent, type AgentEventCallbacks } from '../agent/runner'
import { mapPersistedHistory } from '../agent/messageMapper'
import { getMcpConnectionStatus } from '../mcp/client'
import { getSkillsSystemPrompt } from '../skill/manager'
import * as db from '../store/db'
import { generateId } from '../id'
import { getToolPermission, isAlwaysConfirm, type ToolRegistry } from '../tools/registry'

export interface TelegramAgentMessage {
  accountId: string
  conversationId: string
  conversationTitle: string
  senderName: string
  text: string
  signal: AbortSignal
  onSessionReady?: (sessionId: string) => boolean | void
}

export interface TelegramAgentResult {
  sessionId: string
  text: string
}

export class TelegramAgentBridge {
  private readonly tools: ToolRegistry

  constructor(tools: ToolRegistry) {
    this.tools = tools
  }

  async handle(message: TelegramAgentMessage): Promise<TelegramAgentResult> {
    const settings = db.getSettings()
    const provider = settings.providers.find(item => item.id === settings.activeProviderId)
    if (!provider) throw new Error('No active LLM provider is configured.')

    const session = db.getOrCreateBotSession(
      'telegram',
      message.accountId,
      message.conversationId,
      message.conversationTitle
    )
    if (message.onSessionReady?.(session.id) === false) {
      throw new Error('This Telegram conversation already has a running Agent.')
    }
    const userMessage: UIMessage = {
      id: generateId(),
      sessionId: session.id,
      role: 'user',
      content: message.text,
      timestamp: Date.now(),
      status: 'done'
    }
    db.addMessage(userMessage)

    const history = db.getMessages(session.id)
    const mapped = mapPersistedHistory(history)
    const answerParts: string[] = []
    const callbacks = this.buildCallbacks(session.id, answerParts)

    await runAgent({
      messages: mapped.messages,
      messageIds: mapped.ids,
      compaction: db.getSessionCompaction(session.id),
      provider,
      workspacePath: session.workspacePath || settings.workspacePath,
      sessionId: session.id,
      signal: message.signal,
      permissionCheck: async (toolName, args) =>
        !isAlwaysConfirm(toolName) && getToolPermission(toolName, args) === 'safe',
      memoryEnabled: settings.memoryEnabled !== false,
      maxRounds: settings.maxRounds,
      skillsPrompt: getSkillsSystemPrompt(),
      systemPromptExtra: `You are replying through Telegram to ${message.senderName}. Use plain text and keep the response concise.`,
      promptRuntime: {
        tools: this.tools.definitions(),
        builtinTools: this.tools.definitionsBySource('builtin'),
        mcpTools: this.tools.definitionsBySource(source => source.startsWith('mcp:')),
        mcpServers: getMcpConnectionStatus()
      },
      toolRegistry: this.tools,
      onSessionTitleUpdate: (sessionId, title) => db.updateSessionTitle(sessionId, title),
      onAutoCompact: state => db.setSessionCompaction({ sessionId: session.id, ...state, createdAt: Date.now() })
    }, callbacks)

    return { sessionId: session.id, text: answerParts.join('\n\n').trim() || '(No response)' }
  }

  private buildCallbacks(sessionId: string, answerParts: string[]): AgentEventCallbacks {
    return {
      onToolResult: (toolCallId, toolName, result, isError) => {
        const id = generateId()
        db.addMessage({
          id, sessionId, role: 'tool', content: result, toolCallId, toolName,
          timestamp: Date.now(), status: isError ? 'error' : 'done'
        })
        return id
      },
      onAssistantMessage: (content: string, toolCalls: ToolCall[], reasoning?: string) => {
        if (!content && toolCalls.length === 0 && !reasoning) return null
        const id = generateId()
        db.addMessage({
          id, sessionId, role: 'assistant', content: content || '', reasoning,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: Date.now(), status: 'done'
        })
        if (content.trim()) answerParts.push(content.trim())
        return id
      },
      onTokenUsage: (usage, model) => {
        db.addTokenUsage(model, usage.prompt_tokens, usage.completion_tokens, Date.now())
      }
    }
  }
}

export function isTelegramAgentAbort(error: unknown): boolean {
  return error instanceof AgentAbortedError
}
