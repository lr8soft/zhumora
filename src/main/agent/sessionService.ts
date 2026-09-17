import type {
  AppSettings,
  AutoApproveMode,
  ChatMessage,
  ReasoningEffort,
  Session,
  UIMessage,
  UserMessageInput
} from '../../shared/types.ts'
import { AgentAbortedError } from '../../shared/types.ts'
import { sessionNeedsTitle } from '../../shared/sessionTitle.ts'
import { buildEffectiveConversation, sanitizeHistoryWithIds } from './history.ts'
import { mapPersistedHistory } from './messageMapper.ts'
import { createPersistedAgentCallbacks, type AgentEventSink } from './persistedCallbacks.ts'
import type { PermissionBroker, PermissionPresenter } from './permissionBroker.ts'
import type { AgentRunOptions, runAgent } from './runner.ts'
import { collectUserTexts, ensureSessionTitle } from './titleService.ts'
import { SessionEventHub } from './sessionEventHub.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { generateId } from '../id.ts'

type Provider = AppSettings['providers'][number]

export interface SessionStore {
  createSession(title?: string, workspacePath?: string): Session
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

interface ActiveSessionRun {
  controller: AbortController
  events: AgentEventSink
  unlinkSignal?: () => void
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

interface SessionServiceDependencies {
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

export class SessionBusyError extends Error {}

/** 中止后的 settle 兜底超时：正常路径 runner 在 abort 后毫秒级 settle
 *（provider 重试循环监听信号、在途请求被 fetch 中断、权限等待被取消）；
 * 超时仅在 runner 因未响应信号的路径真正卡死时触发，强制释放 busy 状态。 */
const ABORT_SETTLE_TIMEOUT_MS = 2000

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

/** The only application use case allowed to assemble and run an Agent session. */
export class SessionService {
  readonly events = new SessionEventHub()
  private readonly deps: SessionServiceDependencies
  private readonly active = new Map<string, ActiveSessionRun>()
  private readonly approveModes = new Map<string, AutoApproveMode>()
  private readonly executeAgent: typeof runAgent
  private readonly nextMessageId: () => string
  private readonly now: () => number

  constructor(deps: SessionServiceDependencies) {
    this.deps = deps
    this.executeAgent = deps.executeAgent
    this.nextMessageId = deps.generateMessageId || generateId
    this.now = deps.now || Date.now
  }

  async sendMessage(request: SessionRunRequest): Promise<SessionRunHandle> {
    const { sessionId } = request
    if (this.active.has(sessionId)) throw new SessionBusyError('This session already has a running agent.')
    if (request.signal?.aborted) throw new AgentAbortedError()

    const session = this.deps.store.getSession(sessionId)
    if (!session) throw new Error('Session not found.')
    const settings = this.deps.store.getSettings()
    const provider = this.resolveProvider(settings, request.providerId)
    if (request.approveMode) this.setApproveMode(sessionId, request.approveMode)

    const settleDefer = deferred<void>()
    const run: ActiveSessionRun = {
      controller: new AbortController(),
      events: this.events.forRun(request.localEvents),
      abortNotified: false,
      aborted: false,
      settled: settleDefer.promise,
      settle: settleDefer.resolve
    }
    this.active.set(sessionId, run)
    this.linkExternalSignal(sessionId, run, request.signal)
    run.events.running?.(sessionId, true)

    try {
      const commonPrompt = await this.deps.getSystemPromptExtra?.(sessionId)
      if (run.controller.signal.aborted) throw new AgentAbortedError()

      const userMessage = this.persistUserMessage(sessionId, request.message)
      run.events.userMessage?.(userMessage, request.inputSource || 'renderer')
      const mapped = mapPersistedHistory(this.deps.store.getMessages(sessionId))
      const needsTitle = sessionNeedsTitle(session.title)
      const callbacks = createPersistedAgentCallbacks(sessionId, this.deps.store, this.nextMessageId, run.events)
      const permissionCheck = this.deps.permissions.createCheck({
        sessionId,
        mode: () => this.getApproveMode(sessionId),
        registry: this.deps.tools,
        presenters: request.permissionPresenters,
        timeoutMs: request.permissionTimeoutMs
      })
      const runnerOptions: AgentRunOptions = {
        messages: mapped.messages,
        messageIds: mapped.ids,
        compaction: this.deps.store.getSessionCompaction(sessionId),
        provider,
        workspacePath: session.workspacePath || settings.workspacePath,
        sessionId,
        signal: run.controller.signal,
        permissionCheck,
        modelOverride: request.modelOverride,
        reasoningEffort: request.reasoningEffort,
        systemPromptExtra: [request.sourcePrompt, commonPrompt].filter(Boolean).join('\n\n'),
        memoryEnabled: settings.memoryEnabled !== false,
        maxRounds: settings.maxRounds,
        skillsPrompt: this.deps.getSkillsPrompt(),
        promptRuntime: {
          tools: this.deps.tools.definitions(),
          builtinTools: this.deps.tools.definitionsBySource('builtin'),
          mcpTools: this.deps.tools.definitionsBySource(source => source.startsWith('mcp:')),
          mcpServers: this.deps.getMcpStatus()
        },
        toolRegistry: this.deps.tools,
        sessionNeedsTitle: needsTitle,
        onSessionTitleUpdate: (id, title) => run.events.titleUpdated?.(id, title),
        onAutoCompact: state => this.deps.store.setSessionCompaction({ sessionId, ...state, createdAt: this.now() })
      }
      const completion = this.finishRun(sessionId, run, runnerOptions, callbacks, {
        provider,
        modelOverride: request.modelOverride,
        needsTitle,
        userTexts: collectUserTexts(mapped.messages)
      })
      // runner promise 的失败必然被 finishRun 映射为 abort/error 事件，
      // 但存在不被 await 的场景（abort 兜底强制清理后 runner 迟到的 reject）
      // —— 挂一个静默消费者防止 unhandled rejection。
      void completion.catch(() => {})
      // handle.completion 保留既有契约（中止 reject AgentAbortedError、
      // 普通错误原样抛出），同时获得有界性：与有界 settled 竞速，卡死的
      // runner 在兜底触发时让出，中止语义由 run.aborted 补齐。
      const handleCompletion: Promise<void> = Promise.race([completion, run.settled]).then(
        () => {
          if (run.aborted) throw new AgentAbortedError()
        },
        (error: unknown) => {
          if (run.aborted) throw new AgentAbortedError()
          throw error
        }
      )
      return { sessionId, userMessage, completion: handleCompletion }
    } catch (error) {
      this.cleanupRun(sessionId, run)
      throw error
    }
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  runningSessionIds(): string[] {
    return [...this.active.keys()]
  }

  createSession(title?: string, workspacePath?: string): Session {
    return this.deps.store.createSession(title, workspacePath)
  }

  listSessions(): Session[] {
    return this.deps.store.getSessions()
  }

  getSession(sessionId: string): Session | null {
    return this.deps.store.getSession(sessionId)
  }

  getMessages(sessionId: string): UIMessage[] {
    return this.deps.store.getMessages(sessionId)
  }

  getCompaction(sessionId: string): ReturnType<SessionStore['getSessionCompaction']> {
    return this.deps.store.getSessionCompaction(sessionId)
  }

  renameSession(sessionId: string, title: string): void {
    this.deps.store.updateSessionTitle(sessionId, title)
    this.events.publish(sink => sink.titleUpdated?.(sessionId, title))
  }

  updateWorkspace(sessionId: string, workspacePath: string): void {
    this.deps.store.updateSessionWorkspace(sessionId, workspacePath)
  }

  resolveExternalSession(channel: string, accountId: string, conversationId: string, title: string): Session {
    return this.deps.store.getOrCreateBotSession(channel, accountId, conversationId, title)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const run = this.active.get(sessionId)
    this.forgetSession(sessionId)
    // 等待 settle 而不是裸 runner promise：runner 若因未响应信号的路径
    // 卡死，abort 的有界兜底超时（abortRun）会强制清理并 resolve settled，
    // 删除不会被永久挂起（AGENTS.md：删除活动会话必须先中止并等待
    // completion settle，再删数据库）。
    if (run) await run.settled
    this.deps.store.deleteSession(sessionId)
  }

  async stopAll(): Promise<void> {
    const runs = [...this.active.entries()]
    for (const [sessionId, run] of runs) this.abortRun(sessionId, run)
    await Promise.allSettled(runs.map(([, run]) => run.settled))
  }

  abort(sessionId: string): boolean {
    const run = this.active.get(sessionId)
    if (!run) return false
    this.abortRun(sessionId, run)
    return true
  }

  getApproveMode(sessionId: string): AutoApproveMode {
    return this.approveModes.get(sessionId) || 'manual'
  }

  setApproveMode(sessionId: string, mode: AutoApproveMode): void {
    this.approveModes.set(sessionId, mode)
  }

  forgetSession(sessionId: string): void {
    this.abort(sessionId)
    this.deps.permissions.cancelSession(sessionId)
    this.approveModes.delete(sessionId)
  }

  async compact(sessionId: string): Promise<SessionCompactInfo> {
    if (this.isRunning(sessionId)) throw new SessionBusyError('Agent is running. Wait for it to finish before compacting.')
    const settings = this.deps.store.getSettings()
    const provider = this.resolveProvider(settings)
    const history = this.deps.store.getMessages(sessionId)
    if (history.length < 4) return { beforeTokens: 0, afterTokens: 0, compressedCount: 0, keptCount: history.length }

    const { messages, ids } = mapPersistedHistory(history)
    const sanitized = sanitizeHistoryWithIds(messages, ids)
    const compaction = this.deps.store.getSessionCompaction(sessionId)
    const built = buildEffectiveConversation(sanitized.messages, sanitized.ids, compaction)
    const effectiveIds: Array<string | null> = built.hasSummary
      ? [null, ...sanitized.ids.slice(built.keptFromIndex)]
      : [...sanitized.ids]
    const contextWindow = await this.deps.fetchContextWindow(provider)
    const plan = await this.deps.planAutoCompact(built.effective, provider, undefined, contextWindow)
    const info = {
      beforeTokens: plan.beforeTokens,
      afterTokens: plan.afterTokens,
      compressedCount: plan.compressedCount,
      keptCount: plan.keptCount
    }
    if (plan.compressedCount <= 0) return info

    const boundaryMessageId = effectiveIds[plan.keptOffset - 1] || compaction?.upToMessageId || null
    if (!boundaryMessageId || !plan.summary) throw new Error('Summary generation failed. Check the LLM provider settings and try again.')
    this.deps.store.setSessionCompaction({ sessionId, upToMessageId: boundaryMessageId, summary: plan.summary, createdAt: this.now() })
    this.events.publish(sink => sink.compact?.(sessionId, { source: 'manual', boundaryMessageId, ...info }))
    this.deps.log?.('info', `Manual compact done: sessionId=${sessionId}, boundary=${boundaryMessageId}, ${plan.beforeTokens} → ${plan.afterTokens} tokens`)
    return info
  }

  private resolveProvider(settings: AppSettings, providerId?: string): Provider {
    const provider = settings.providers.find(item => item.id === (providerId || settings.activeProviderId))
    if (!provider) throw new Error('No active provider. Please configure one in Settings.')
    return provider
  }

  private persistUserMessage(sessionId: string, input: UserMessageInput): UIMessage {
    const images = (input.images || []).filter(value => typeof value === 'string' && value.startsWith('data:image/'))
    const message: UIMessage = {
      id: this.nextMessageId(),
      sessionId,
      role: 'user',
      content: input.text,
      images: images.length > 0 ? images : undefined,
      timestamp: this.now(),
      status: 'done'
    }
    this.deps.store.addMessage(message)
    return message
  }

  private finishRun(
    sessionId: string,
    run: ActiveSessionRun,
    options: AgentRunOptions,
    callbacks: ReturnType<typeof createPersistedAgentCallbacks>,
    title: { provider: Provider; modelOverride?: string; needsTitle: boolean; userTexts: string[] }
  ): Promise<void> {
    return this.executeAgent(options, callbacks).then(() => undefined).catch(error => {
      if (error instanceof AgentAbortedError || run.controller.signal.aborted) {
        this.abortRun(sessionId, run)
        throw error instanceof AgentAbortedError ? error : new AgentAbortedError()
      }
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))
      throw error
    }).finally(() => {
      this.cleanupRun(sessionId, run)
      if (title.needsTitle) void this.ensureTitle(sessionId, run.events, title)
    })
  }

  private async ensureTitle(
    sessionId: string,
    events: AgentEventSink,
    options: { provider: Provider; modelOverride?: string; userTexts: string[] }
  ): Promise<void> {
    await ensureSessionTitle({
      provider: options.provider,
      sessionId,
      modelOverride: options.modelOverride,
      completeFn: this.deps.completeText,
      userTexts: options.userTexts,
      store: {
        getSessionTitle: id => this.deps.store.getSession(id)?.title ?? null,
        applyGeneratedTitle: (id, title) => {
          if (this.deps.store.tryUpdateSessionTitleIfDefault(id, title)) events.titleUpdated?.(id, title)
        }
      }
    })
  }

  private linkExternalSignal(sessionId: string, run: ActiveSessionRun, signal?: AbortSignal): void {
    if (!signal) return
    const abort = () => this.abortRun(sessionId, run)
    signal.addEventListener('abort', abort, { once: true })
    run.unlinkSignal = () => signal.removeEventListener('abort', abort)
  }

  private abortRun(sessionId: string, run: ActiveSessionRun): void {
    run.aborted = true
    run.controller.abort()
    this.deps.permissions.cancelSession(sessionId)
    if (!run.abortNotified) {
      run.abortNotified = true
      run.events.aborted?.(sessionId)
      // 兜底：正常情况下 runner 听到信号后毫秒级 settle 并触发 cleanupRun
      // （见 finishRun 的 finally）。若 runner 因未响应信号的路径卡死，
      // 有界超时强制清理，保证 abort 后会话最终一定可再次运行 ——
      // 这是"停止后切换 provider 报 session busy" bug 的最后一道防线。
      // 定时器保持引用（不能 unref）：兜底的职责就是在进程其它工作排空时
      // 也保证触发；runner 正常 settle 时 cleanupRun 会提前清除它，
      // 正常路径下这个 2s 引用窗口不会真正保留进程。
      run.settleTimer = setTimeout(() => {
        this.deps.log?.('error', `Session ${sessionId}: run did not settle within ${ABORT_SETTLE_TIMEOUT_MS}ms after abort, forcing cleanup`)
        this.cleanupRun(sessionId, run)
      }, ABORT_SETTLE_TIMEOUT_MS)
    }
  }

  private cleanupRun(sessionId: string, run: ActiveSessionRun): void {
    if (this.active.get(sessionId) !== run) return
    if (run.settleTimer) clearTimeout(run.settleTimer)
    run.settleTimer = undefined
    run.unlinkSignal?.()
    this.deps.permissions.cancelSession(sessionId)
    this.active.delete(sessionId)
    run.events.running?.(sessionId, false)
    run.settle()
  }
}
