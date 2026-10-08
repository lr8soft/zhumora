import type { AppSettings, AutoApproveMode, ChatMessage, ReasoningEffort, Session, UIMessage, UserMessageInput } from '../../shared/types.ts'
import type { AgentEventSink } from './persistedCallbacks.ts'
import type { PermissionBroker, PermissionPresenter } from './permissionBroker.ts'
import type { AgentRunOptions, runAgent } from './runner.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { SubagentScope } from './subagentScope.ts'

type Provider = AppSettings['providers'][number]

export interface SessionStore {
  createSession(title?: string, workspacePath?: string, subagent?: Session['subagent']): Session
  getSessions(): Session[]
  getSettings(): AppSettings
  getSession(id: string): Session | null
  updateSessionTitle(id: string, title: string): void
  updateSessionWorkspace(id: string, workspacePath: string): void
  deleteSession(id: string): void
  getOrCreateBotSession(channel: string, accountId: string, conversationId: string, title: string): Session
  getMessages(sessionId: string): UIMessage[]
  addMessage(message: UIMessage): void
  getSessionCompaction(sessionId: string): { sessionId: string; upToMessageId: string; summary: string; createdAt: number } | null
  setSessionCompaction(record: { sessionId: string; upToMessageId: string; summary: string; createdAt: number }): void
  tryUpdateSessionTitleIfDefault(sessionId: string, title: string): boolean
  addTokenUsage(model: string, inputTokens: number, outputTokens: number, createdAt?: number): void
}

export interface SessionRunRequest {
  sessionId: string
  message: UserMessageInput
  providerId?: string
  modelOverride?: string
  reasoningEffort?: ReasoningEffort
  approveMode?: AutoApproveMode
  sourcePrompt?: string
  inputSource?: 'renderer' | 'external'
  localEvents?: AgentEventSink
  permissionPresenters?: PermissionPresenter[]
  permissionTimeoutMs?: number
  signal?: AbortSignal
}

export interface SessionRunHandle {
  sessionId: string
  userMessage: UIMessage
  /** 运行 settle 承诺，保留既有错误语义：中止时 reject AgentAbortedError，
   * 普通错误原样 reject，正常完成 resolve。相比裸 runner promise 的唯一
   * 变化是有界性 —— abort 后 runner 若因未响应信号的路径卡死，兜底清理
   * 触发时本承诺立即以 AgentAbortedError settle，消费者（IPC 日志、
   * Bot FIFO、删除等待）不会永久挂起。 */
  completion: Promise<void>
}

export interface SessionCompactInfo {
  beforeTokens: number
  afterTokens: number
  compressedCount: number
  keptCount: number
}

export interface ActiveSessionRun {
  controller: AbortController
  events: AgentEventSink
  unlinkSignal?: () => void
  subagents?: SubagentScope
  approvalParentId?: string
  abortNotified: boolean
  /** abortRun 已触发（controller.abort 之外的本地标记） */
  aborted: boolean
  /** run 真正 settle（或 abort 后 settle 超时兜底触发）时 resolve。
   *  deleteSession / stopAll / handle.completion 等待它而不是裸 runner
   *  promise：卡死的 runner 不能无限期挂起会话删除、应用退出或 Bot FIFO。 */
  settled: Promise<void>
  settle: () => void
  /** abort 后启动的 settle 兜底定时器；cleanupRun 时清除 */
  settleTimer?: ReturnType<typeof setTimeout>
}

export interface SessionServiceDependencies {
  store: SessionStore
  tools: ToolRegistry
  permissions: PermissionBroker
  getSkillsPrompt: () => string
  getMcpStatus: () => { id: string; name: string; connected: boolean }[]
  getSystemPromptExtra?: (sessionId: string) => Promise<string>
  executeAgent: typeof runAgent
  fetchContextWindow: (provider: Provider, modelOverride?: string) => Promise<number>
  planAutoCompact: (
    messages: ChatMessage[],
    provider: Provider,
    modelOverride: string | undefined,
    contextWindow: number,
    signal?: AbortSignal
  ) => Promise<{
    beforeTokens: number
    afterTokens: number
    compressedCount: number
    keptCount: number
    keptOffset: number
    summary: string | null
  }>
  completeText: (provider: Provider, messages: ChatMessage[], model?: string, maxTokens?: number) => Promise<string>
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  generateMessageId?: () => string
  now?: () => number
}

