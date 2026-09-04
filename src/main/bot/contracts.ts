import type { AppSettings, AutoApproveMode, Session, UIMessage } from '../../shared/types'
import type { AgentEventSink } from '../agent/persistedCallbacks'
import type { PermissionPresenter } from '../agent/permissionBroker'

export interface BotAgentMessage {
  channel: string
  accountId: string
  conversationId: string
  conversationTitle: string
  senderId: string
  senderName: string
  text: string
  approveMode: AutoApproveMode
  signal: AbortSignal
  events: AgentEventSink
  permissionPresenters?: PermissionPresenter[]
  permissionTimeoutMs?: number
  onSessionReady?: (sessionId: string) => boolean | void
}

export interface BotAgentResult {
  sessionId: string
}

export interface BotActivity {
  sessionId: string
  state: 'running' | 'complete' | 'error' | 'aborted'
}

export interface BotAgentStore {
  getSettings(): AppSettings
  getOrCreateBotSession(channel: string, accountId: string, conversationId: string, title: string): Session
  addMessage(message: UIMessage): void
  getMessages(sessionId: string): UIMessage[]
  getSessionCompaction(sessionId: string): { sessionId: string; upToMessageId: string; summary: string; createdAt: number } | null
  setSessionCompaction(record: { sessionId: string; upToMessageId: string; summary: string; createdAt: number }): void
  updateSessionTitle(sessionId: string, title: string): void
  addTokenUsage(model: string, inputTokens: number, outputTokens: number, createdAt?: number): void
}

/** Platform-neutral lifecycle surface consumed by the application composition root. */
export interface BotPlatformRuntime {
  readonly channel: string
  stop(): Promise<void>
  abortSession(sessionId: string): boolean
  setAgentEventSink(sink: AgentEventSink): void
  setActivityListener(listener: (activity: BotActivity) => boolean | void): void
}

/** Configuration extension implemented by each concrete platform adapter. */
export interface BotPlatformService<TConfig> extends BotPlatformRuntime {
  configure(config: TConfig): Promise<void>
}
