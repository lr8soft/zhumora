import { AgentAbortedError } from '../../shared/types'
import { runAgent } from '../agent/runner'
import { mapPersistedHistory } from '../agent/messageMapper'
import { createPersistedAgentCallbacks } from '../agent/persistedCallbacks'
import type { PermissionBroker } from '../agent/permissionBroker'
import { generateId } from '../id'
import type { ToolRegistry } from '../tools/registry'
import type { BotAgentMessage, BotAgentResult, BotAgentStore } from './contracts'

interface BotAgentBridgeDependencies {
  tools: ToolRegistry
  permissions: PermissionBroker
  store: BotAgentStore
  getSkillsPrompt: () => string
  getMcpStatus: () => { id: string; name: string; connected: boolean }[]
}

/** Platform-neutral Agent orchestration reused by every chat-bot transport. */
export class BotAgentBridge {
  private readonly deps: BotAgentBridgeDependencies

  constructor(deps: BotAgentBridgeDependencies) {
    this.deps = deps
  }

  async handle(message: BotAgentMessage): Promise<BotAgentResult> {
    const settings = this.deps.store.getSettings()
    const provider = settings.providers.find(item => item.id === settings.activeProviderId)
    if (!provider) throw new Error('No active LLM provider is configured.')

    const session = this.deps.store.getOrCreateBotSession(
      message.channel,
      message.accountId,
      message.conversationId,
      message.conversationTitle
    )
    if (message.onSessionReady?.(session.id) === false) {
      throw new Error('This bot conversation already has a running Agent.')
    }

    const userMessage = {
      id: generateId(), sessionId: session.id, role: 'user' as const, content: message.text,
      timestamp: Date.now(), status: 'done' as const
    }
    this.deps.store.addMessage(userMessage)
    message.events.userMessage?.(userMessage)

    const history = this.deps.store.getMessages(session.id)
    const mapped = mapPersistedHistory(history)
    const callbacks = createPersistedAgentCallbacks(session.id, this.deps.store, generateId, message.events)
    const permissionCheck = this.deps.permissions.createCheck({
      sessionId: session.id,
      mode: () => message.approveMode,
      registry: this.deps.tools,
      presenters: message.permissionPresenters,
      timeoutMs: message.permissionTimeoutMs
    })

    try {
      await runAgent({
        messages: mapped.messages,
        messageIds: mapped.ids,
        compaction: this.deps.store.getSessionCompaction(session.id),
        provider,
        workspacePath: session.workspacePath || settings.workspacePath,
        sessionId: session.id,
        signal: message.signal,
        permissionCheck,
        memoryEnabled: settings.memoryEnabled !== false,
        maxRounds: settings.maxRounds,
        skillsPrompt: this.deps.getSkillsPrompt(),
        systemPromptExtra: `You are replying through ${message.channel} to ${message.senderName}. Use plain text and keep the response concise.`,
        promptRuntime: {
          tools: this.deps.tools.definitions(),
          builtinTools: this.deps.tools.definitionsBySource('builtin'),
          mcpTools: this.deps.tools.definitionsBySource(source => source.startsWith('mcp:')),
          mcpServers: this.deps.getMcpStatus()
        },
        toolRegistry: this.deps.tools,
        onSessionTitleUpdate: (sessionId, title) => this.deps.store.updateSessionTitle(sessionId, title),
        onAutoCompact: state => this.deps.store.setSessionCompaction({ sessionId: session.id, ...state, createdAt: Date.now() })
      }, callbacks)
    } catch (error) {
      if (!(error instanceof AgentAbortedError)) {
        callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    }

    return { sessionId: session.id }
  }
}
