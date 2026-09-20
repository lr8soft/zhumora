// ============================================================
// MCP 入站服务器 — 会话编排层（无 HTTP）。
// 外部编排器（Claude Code / Codex 等）把 Zhumora 当一个"可对话的协作者"：
//   zhumora_chat  → 一条委托消息（BotSessionAdapter → SessionService 唯一运行入口）
//   zhumora_respond → 按用户授权裁决权限请求（仅 delegate 模式 + normal 级）
//   zhumora_wait → 事件驱动等待 + 完成回调；zhumora_status → 瞬时诊断快照
// 传输（loopback HTTP + Bearer）在 transport.ts；本文件只做会话编排。
// 约束（ARCHITECTURE.md 第 5/12 节）：本模块是纯输入适配器——
// 不 import runner/store，不持有 active runs / abort controllers / approve modes，
// 同会话 FIFO 用 BotMessageQueue，外部身份映射走 SessionService 存储边界。
// ============================================================
import { AgentAbortedError } from '../../shared/types.ts'
import {
  MCP_SOURCE_PROMPT,
  type McpServerSettings
} from '../../shared/mcpServer.ts'
import { BotMessageQueue } from '../bot/messageQueue.ts'
import type { BotSessionAdapter } from '../bot/sessionAdapter.ts'
import type { SessionService } from '../agent/sessionService.ts'
import type { PermissionBroker } from '../agent/permissionBroker.ts'
import {
  createMcpTaskSession,
  DelegatePermissionPresenter,
  delegateAllowsExternal,
  type McpTaskActivityListener,
  type McpTaskPermission,
  type McpTaskSession,
  type McpTaskSnapshot,
  type McpTaskSnapshotOptions,
  type McpTaskStatus
} from '../agent/taskProtocol.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { log } from '../llm/logger.ts'

/** 权限等待超时：比 Bot（10 分钟）短——编排器的回合预算有限，超时 fail-closed。 */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000
/** 单次 zhumora_chat 的输入长度上限（防超大 prompt 打穿上下文与日志）。 */
const MAX_MESSAGE_CHARS = 120_000
/** 外部"账号"标识：入站服务器本身就是一个账号，对话键在其下稳定映射会话。 */
const ACCOUNT_ID = 'inbound'

interface Conversation {
  key: string
  sessionKey: string
  title: string
  /** 当前任务（running / awaiting_permission 期间非 null）。 */
  task: McpTaskSession | null
  /** 上一任务：保留终态和有界活动环，供完成回调/断线重连后取回。 */
  lastTask: McpTaskSession | null
  nextTaskNumber: number
}

export class McpInboundService {
  private readonly queue = new BotMessageQueue()
  private readonly conversations = new Map<string, Conversation>()
  private readonly agent: BotSessionAdapter
  private readonly sessions: SessionService
  private readonly permissions: PermissionBroker
  private readonly registry: ToolRegistry
  private settings: McpServerSettings

  constructor(
    agent: BotSessionAdapter,
    sessions: SessionService,
    permissions: PermissionBroker,
    registry: ToolRegistry,
    initialSettings: McpServerSettings
  ) {
    this.agent = agent
    this.sessions = sessions
    this.permissions = permissions
    this.registry = registry
    this.settings = initialSettings
  }

  updateSettings(settings: McpServerSettings): void {
    this.settings = settings
  }

  async stop(): Promise<void> {
    await this.queue.stop()
    this.conversations.clear()
  }

  /** 投递一条委托消息。已有运行中任务时立即返回其状态（不排队第二条）。 */
  async chat(
    conversationKey: string,
    text: string,
    waitMs?: number,
    onActivity?: McpTaskActivityListener
  ): Promise<McpTaskStatus> {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!trimmed) return { status: 'failed', error: 'Message text is required.' }
    if (trimmed.length > MAX_MESSAGE_CHARS) {
      return { status: 'failed', error: `Message exceeds ${MAX_MESSAGE_CHARS} characters.` }
    }
    const conversation = this.conversation(conversationKey)
    if (conversation.task) return conversation.task.status()
    const task = createMcpTaskSession(`task-${++conversation.nextTaskNumber}`)
    conversation.task = task
    // 投递到同会话 FIFO，但不 await 其完成：完成/失败由 task 的 complete 事件
    // 与 runTask 的 settle 驱动。chat 只"投递 + 至多等 waitMs"，超时即转后台，
    // 任务仍在 conversation.task 上继续，下一次 chat 会拿到其当前状态。
    void this.queue.enqueue(conversation.key, signal => this.runTask(conversation, task, trimmed, signal))
      .catch(error => {
        if (error instanceof AgentAbortedError) task.settle({ status: 'aborted' })
        else task.settle({ status: 'failed', error: safeError(error) })
      })
    return this.waitWithActivity(task, waitMs, onActivity)
  }

  /** 当前或最近一次任务的有界快照；只查不建会话。 */
  snapshot(
    conversationKey: string,
    afterCursor = 0,
    options?: McpTaskSnapshotOptions
  ): McpTaskSnapshot | null {
    return this.currentTask(conversationKey)?.snapshot(afterCursor, options) ?? null
  }

  /**
   * 事件驱动等待：terminal 模式一直等到完成/权限/超时；update 模式等游标前进。
   * taskId 防止调用方把上一任务的 cursor 错套到下一任务。
   */
  async waitForTask(
    conversationKey: string,
    taskId: string,
    afterCursor: number,
    waitMs: number,
    returnOn: 'terminal' | 'update',
    snapshotOptions?: McpTaskSnapshotOptions,
    onActivity?: McpTaskActivityListener
  ): Promise<McpTaskSnapshot> {
    const task = this.currentTask(conversationKey)
    if (!task) throw new Error('No Zhumora task exists for this MCP session.')
    if (task.taskId !== taskId) {
      throw new Error(`Task ${taskId} is no longer current; current task is ${task.taskId}.`)
    }
    const unsubscribe = onActivity ? task.subscribe(onActivity) : undefined
    try {
      if (returnOn === 'update') {
        await task.waitForUpdate(afterCursor, waitMs, snapshotOptions?.includeReasoning)
      }
      else await task.wait(waitMs)
      return task.snapshot(afterCursor, snapshotOptions)
    } finally {
      unsubscribe?.()
    }
  }

  /** 外部编排器裁决权限请求（zhumora_respond 的唯一路径 → PermissionBroker）。 */
  respond(conversationKey: string, permissionId: string, allow: boolean, reason?: string): McpTaskStatus {
    // 只查不建：对未知/已结束对话的裁决尝试不应产生新会话副作用。
    const task = this.conversations.get(conversationKey)?.task
    if (!task) return this.status(conversationKey)
    const permission = task.getPermission(permissionId)
    if (!permission) {
      // 请求已不在本任务挂起（已被 UI 先答 / 运行结束）：不伪造错误，回当前状态。
      return task.status()
    }
    if (!this.canExternalDecide(permission)) {
      // 硬边界：外部不可裁决（delegate 关闭 / dangerous / alwaysConfirm）。
      // 批准和拒绝都属于裁决；两者都必须留给桌面 UI，不能让外部通过
      // allow=false 绕过权限所有权。
      // 不触碰 broker——请求保持挂起，由 Zhumora 桌面 UI 的人类裁决。
      log('warn', `MCP permission ${permissionId}: ${permission.toolName} (${permission.level}) cannot be decided by an external orchestrator; left to the user`)
      return this.status(conversationKey)
    }
    if (reason) log('info', `MCP permission ${permissionId} ${allow ? 'approved' : 'denied'} by orchestrator: ${reason.slice(0, 200)}`)
    const settled = this.permissions.respond(permissionId, allow)
    if (!settled) log('warn', `MCP permission ${permissionId} is no longer active; ignoring external decision`)
    return task.status()
  }

  /** 运行中 / 等待权限 / 终态（供瞬时 status 快照）。只查不建，不产生会话。 */
  status(conversationKey: string): McpTaskStatus {
    const conversation = this.conversations.get(conversationKey)
    if (!conversation) return { status: 'busy' }
    return conversation.task?.status() ?? conversation.lastTask?.status() ?? { status: 'busy' }
  }

  /** 外部 conversation → Zhumora sessionId（首次访问时经 SessionService 映射并缓存）。 */
  resolveSessionId(conversationKey: string): string {
    return this.conversation(conversationKey).sessionKey
  }

  /** 仅 delegate 模式 + normal 级 + 非 alwaysConfirm 可被外部裁决（taskProtocol 硬边界）。 */
  canExternalDecide(permission: McpTaskPermission): boolean {
    return this.settings.permissionMode === 'delegate'
      && delegateAllowsExternal(permission.level, this.registry.alwaysConfirm(permission.toolName))
  }

  private conversation(conversationKey: string): Conversation {
    let conversation = this.conversations.get(conversationKey)
    if (!conversation) {
      // 外部身份映射是 SessionService 存储边界的职责（Bot 同一规则）：
      // 同一个 conversationKey 永远落到同一个 Zhumora session。
      const session = this.sessions.resolveExternalSession(
        'mcp',
        ACCOUNT_ID,
        conversationKey,
        `${this.settings.clientLabel} · ${conversationKey}`
      )
      conversation = {
        key: conversationKey,
        sessionKey: session.id,
        title: session.title,
        task: null,
        lastTask: null,
        nextTaskNumber: 0
      }
      this.conversations.set(conversationKey, conversation)
    }
    return conversation
  }

  private async runTask(
    conversation: Conversation,
    task: McpTaskSession,
    text: string,
    signal: AbortSignal
  ): Promise<void> {
    try {
      await this.agent.handle({
        channel: 'mcp',
        accountId: ACCOUNT_ID,
        conversationId: conversation.key,
        conversationTitle: conversation.title,
        senderId: ACCOUNT_ID,
        senderName: this.settings.clientLabel,
        text,
        sourcePrompt: MCP_SOURCE_PROMPT,
        approveMode: this.settings.approveMode,
        signal,
        events: task.sink,
        // 呈现者恒注册：两种模式下任务状态都对编排器可见（awaiting_permission）。
        // 能否裁决由 respond() 的 canExternalDecide 门禁控制（delegate 模式 +
        // normal 级），ui 模式下请求保持挂起等 Zhumora 桌面 UI 的人类裁决。
        permissionPresenters: [new DelegatePermissionPresenter(task)],
        permissionTimeoutMs: PERMISSION_TIMEOUT_MS
      })
      // 正常完成时 task.sink.complete 已 settle；到这里还没有终态说明是空回复。
      task.settle({ status: 'completed', reply: '' })
    } catch (error) {
      if (error instanceof AgentAbortedError || signal.aborted) {
        task.settle({ status: 'aborted' })
      } else {
        log('error', `MCP task failed (${conversation.key}): ${safeError(error)}`)
        task.settle({ status: 'failed', error: safeError(error) })
      }
    } finally {
      // task 此刻必为终态（complete/aborted/failed 均已 settle）：
      // 保留其终态与有界活动环，让编排器在任务对象释放后仍能收到完成回调。
      conversation.lastTask = task
      conversation.task = null
    }
  }

  private currentTask(conversationKey: string): McpTaskSession | null {
    const conversation = this.conversations.get(conversationKey)
    return conversation?.task ?? conversation?.lastTask ?? null
  }

  private async waitWithActivity(
    task: McpTaskSession,
    waitMs: number | undefined,
    onActivity: McpTaskActivityListener | undefined
  ): Promise<McpTaskStatus> {
    const unsubscribe = onActivity ? task.subscribe(onActivity) : undefined
    try {
      return await task.wait(waitMs)
    } finally {
      unsubscribe?.()
    }
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}
