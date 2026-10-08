import type {
  AppSettings,
  AutoApproveMode,
  ChatMessage,
  Session,
  UIMessage,
  UserMessageInput
} from '../../shared/types.ts'
import { AgentAbortedError } from '../../shared/types.ts'
import { sessionNeedsTitle } from '../../shared/sessionTitle.ts'
import { compactSession } from './sessionCompaction.ts'
import { mapPersistedHistory } from './messageMapper.ts'
import type { AgentEventSink } from './persistedCallbacks.ts'
import type { AgentEventCallbacks } from './eventCallbacks.ts'
import { createSessionRunCallbacks, publishRunOutcome } from './sessionRunCallbacks.ts'
import { awaitWithSignal } from './runWait.ts'
import type { AgentRunOptions, runAgent } from './runner.ts'
import { collectUserTexts, ensureSessionTitle } from './titleService.ts'
import { SessionEventHub } from './sessionEventHub.ts'
import { generateId } from '../id.ts'
import { SubagentScope } from './subagentScope.ts'
import { assertSubagentsEnabled, resolveSubagentModel, SUBAGENT_CHILD_GUIDANCE, subagentDelegationGuidance } from './subagentPolicy.ts'
import { createSessionPermissionCheck } from './sessionPermissionCheck.ts'
import type { ActiveSessionRun, SessionStore, SessionRunRequest, SessionRunHandle, SessionCompactInfo, SessionServiceDependencies } from './sessionContracts.ts'

type Provider = AppSettings['providers'][number]

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
    const parentRun = session.subagent ? this.active.get(session.subagent.parentSessionId) : undefined
    if (parentRun && request.signal !== parentRun.controller.signal) {
      throw new SessionBusyError('This subagent is owned by an active parent run.')
    }
    const settings = this.deps.store.getSettings()
    const provider = this.resolveProvider(settings, request.providerId ?? session.subagent?.providerId)
    if (session.subagent && !provider.enabled) throw new Error('Subagent provider is disabled.')
    const modelOverride = request.modelOverride ?? (request.providerId && request.providerId !== session.subagent?.providerId
      ? undefined : session.subagent?.model)
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
    if (!session.subagent) run.subagents = this.createSubagentScope(session, run, request, provider, modelOverride)
    else if (this.active.has(session.subagent.parentSessionId)) run.approvalParentId = session.subagent.parentSessionId
    this.linkExternalSignal(sessionId, run, request.signal)
    run.events.running?.(sessionId, true)

    try {
      const commonPrompt = await awaitWithSignal(this.deps.getSystemPromptExtra?.(sessionId) ?? Promise.resolve(undefined), run.controller.signal)
      if (run.controller.signal.aborted) throw new AgentAbortedError()
      if (parentRun) assertSubagentsEnabled(this.deps.store.getSettings().subagentsEnabled)

      const userMessage = this.persistUserMessage(sessionId, request.message)
      run.events.userMessage?.(userMessage, request.inputSource || 'renderer')
      const mapped = mapPersistedHistory(this.deps.store.getMessages(sessionId))
      const needsTitle = sessionNeedsTitle(session.title)
      const callbacks = createSessionRunCallbacks(sessionId, run, this.deps.store, this.nextMessageId,
        () => this.active.get(sessionId) === run)
      const permissionCheck = createSessionPermissionCheck(this.deps.permissions, {
        sessionId,
        mode: () => run.approvalParentId ? this.getApproveMode(run.approvalParentId) : this.getApproveMode(sessionId),
        registry: this.deps.tools,
        presenters: request.permissionPresenters,
        timeoutMs: request.permissionTimeoutMs,
        signal: run.controller.signal,
        isCurrent: () => this.active.get(sessionId) === run,
        subagentsEnabled: () => this.deps.store.getSettings().subagentsEnabled
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
        modelOverride,
        reasoningEffort: request.reasoningEffort,
        systemPromptExtra: [request.sourcePrompt, commonPrompt,
          session.subagent ? SUBAGENT_CHILD_GUIDANCE : this.deps.tools.get('spawn_subagent') ? subagentDelegationGuidance(settings.subagentsEnabled, settings.subagentModel) : undefined]
          .filter(Boolean).join('\n\n'),
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
        onAutoCompact: state => {
          if (this.active.get(sessionId) === run) this.deps.store.setSessionCompaction({ sessionId, ...state, createdAt: this.now() })
        }
      }
      const completion = this.finishRun(sessionId, run, runnerOptions, callbacks, {
        provider,
        modelOverride,
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
          if (run.outcome?.kind === 'failed') return completion
        },
        (error: unknown) => {
          if (run.aborted) throw new AgentAbortedError()
          throw error
        }
      )
      return { sessionId, userMessage, completion: handleCompletion }
    } catch (error) {
      await run.subagents?.close()
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

  getSubagentScope(sessionId: string | undefined, signal: AbortSignal | undefined): SubagentScope {
    const run = sessionId ? this.active.get(sessionId) : undefined
    if (!run || run.controller.signal !== signal || run.aborted) throw new AgentAbortedError()
    if (!run.subagents) throw new Error('Nested subagent delegation is disabled.')
    return run.subagents
  }

  listSubagentProviders(): { id: string; name: string; defaultModel: string }[] {
    return this.deps.store.getSettings().providers.filter(item => item.enabled)
      .map(({ id, name, defaultModel }) => ({ id, name, defaultModel }))
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
    const subagent = this.deps.store.getSession(sessionId)?.subagent
    const provider = this.resolveProvider(settings, subagent?.providerId)
    return compactSession(sessionId, provider, subagent?.model, { deps: this.deps, events: this.events, now: this.now })
  }

  private resolveProvider(settings: AppSettings, providerId?: string): Provider {
    const provider = settings.providers.find(item => item.id === (providerId || settings.activeProviderId))
    if (!provider) throw new Error('No active provider. Please configure one in Settings.')
    return provider
  }

  private createSubagentScope(
    session: Session, run: ActiveSessionRun, request: SessionRunRequest, provider: Provider, modelOverride?: string
  ): SubagentScope {
    const parent = { providerId: provider.id, model: modelOverride || provider.defaultModel }
    return new SubagentScope({
      assertEnabled: () => assertSubagentsEnabled(this.deps.store.getSettings().subagentsEnabled),
      resolveModel: input => {
        const settings = this.deps.store.getSettings()
        return resolveSubagentModel(settings.providers, parent, input, settings.subagentModel)
      },
      createSession: (description, model) => {
        if (run.controller.signal.aborted) throw new AgentAbortedError()
        return this.deps.store.createSession(description, session.workspacePath || this.deps.store.getSettings().workspacePath,
          { parentSessionId: session.id, ...model })
      },
      start: (childId, prompt, localEvents, presenter) => this.sendMessage({
        sessionId: childId, message: { text: prompt }, inputSource: 'external',
        signal: run.controller.signal, localEvents,
        sourcePrompt: request.sourcePrompt,
        permissionPresenters: [...(request.permissionPresenters || []), presenter],
        permissionTimeoutMs: request.permissionTimeoutMs,
        reasoningEffort: parent.providerId === this.deps.store.getSession(childId)?.subagent?.providerId
          && parent.model === this.deps.store.getSession(childId)?.subagent?.model ? request.reasoningEffort : undefined
      }),
      isRunning: id => this.isRunning(id),
      stop: async id => {
        const child = this.active.get(id)
        if (child) { this.abortRun(id, child); await child.settled }
      },
      waitIdle: async id => {
        await this.active.get(id)?.settled
      }
    }, run.controller.signal)
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
    callbacks: AgentEventCallbacks,
    title: { provider: Provider; modelOverride?: string; needsTitle: boolean; userTexts: string[] }
  ): Promise<void> {
    return this.executeAgent(options, callbacks).then(() => undefined).catch(error => {
      if (error instanceof AgentAbortedError || run.controller.signal.aborted) {
        this.abortRun(sessionId, run)
        throw error instanceof AgentAbortedError ? error : new AgentAbortedError()
      }
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))
      throw error
    }).finally(async () => {
      await run.subagents?.close()
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
    if (this.active.get(sessionId) !== run) return
    run.aborted = true
    run.controller.abort()
    this.deps.permissions.cancelSession(sessionId)
    if (!run.abortNotified) {
      run.abortNotified = true
      run.events.aborted?.(sessionId)
      // runner 不响应中止时，兜底必须释放 busy 并让删除/退出 settle。
      // 定时器保持引用，保证其他工作排空后仍触发；正常 cleanup 会提前清除。
      run.settleTimer = setTimeout(() => {
        this.deps.log?.('error', `Session ${sessionId}: run did not settle within ${ABORT_SETTLE_TIMEOUT_MS}ms after abort, forcing cleanup`)
        void (run.subagents?.close() ?? Promise.resolve()).then(() => this.cleanupRun(sessionId, run))
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
    publishRunOutcome(sessionId, run)
    run.settle()
  }
}
