// ============================================================
// 会话即服务（Session-as-Service）协议。
// 把一次 SessionService 运行的"等待 + 状态翻译"收敛为纯模块，供非 UI
// 调用方复用：MCP 入站服务器（外部编排器）、未来的内部子 agent 工具。
// 不持有 Agent 状态：运行仍由 SessionService 独占，这里只做等待与翻译。
// ============================================================
import type { AgentEventSink } from './persistedCallbacks.ts'
import type { PermissionPresenter, PermissionRequest, PermissionResolution } from './permissionBroker.ts'
import type { PermissionLevel } from '../tools/registry.ts'
import {
  createMcpTaskActivityLog,
  truncateTaskActivityText,
  type McpTaskActivityListener,
  type McpTaskSnapshot,
  type McpTaskSnapshotOptions
} from './taskActivity.ts'

export type {
  McpTaskActivity,
  McpTaskActivityListener,
  McpTaskSnapshot,
  McpTaskSnapshotOptions
} from './taskActivity.ts'

/** 运行对外状态。terminal 状态：completed / failed / aborted / busy。 */
export type McpTaskStatus =
  | { status: 'running' }
  | { status: 'busy' }
  | { status: 'awaiting_permission'; permission: McpTaskPermission }
  | { status: 'completed'; reply: string }
  | { status: 'failed'; error: string }
  | { status: 'aborted' }

export interface McpTaskPermission {
  permissionId: string
  toolName: string
  args: Record<string, unknown>
  level: PermissionLevel
}

export interface McpTaskSession {
  readonly taskId: string
  /** 交给本次运行的 local sink：complete 事件是最终回复的权威来源。 */
  readonly sink: AgentEventSink
  /** 当前状态快照。 */
  status(): McpTaskStatus
  /**
   * 等待到 terminal 或 awaiting_permission，或 waitMs 到期（到期返回当前状态）。
   * 有界性来自底层 run 的有界 settle（见 SessionRunHandle.completion）。
   */
  wait(waitMs?: number): Promise<McpTaskStatus>
  /** 等到游标前进、终态/权限出现或超时；用于事件驱动的长轮询，而非定时轮询。 */
  waitForUpdate(afterCursor: number, waitMs?: number, includeReasoning?: boolean): Promise<McpTaskSnapshot>
  /** 获取 afterCursor 之后的有界增量。 */
  snapshot(afterCursor?: number, options?: McpTaskSnapshotOptions): McpTaskSnapshot
  /** 订阅活动；仅供当前 MCP tool request 转成 notifications/progress。 */
  subscribe(listener: McpTaskActivityListener): () => void
  /** 终态幂等：第一次 settle 生效，之后返回既有终态。 */
  settle(final: McpTaskStatus): McpTaskStatus
  markPermission(permission: McpTaskPermission): void
  clearPermission(permission: { permissionId: string }): void
  getPermission(permissionId: string): McpTaskPermission | null
}

/**
 * 外部编排器的权限上限（不可配置的硬边界）：
 * 只有 normal 级且非能力边界变更（alwaysConfirm）的工具可以被外部批准；
 * dangerous 始终落到人（Zhumora 桌面 UI），safe 在到达呈现者前已被自动放行。
 * 模式开关（permissionMode）由调用方先行判断，本函数只表达"级别是否可委托"。
 */
export function delegateAllowsExternal(level: PermissionLevel, alwaysConfirm: boolean): boolean {
  return !alwaysConfirm && level === 'normal'
}

export function isTerminalMcpTaskStatus(status: McpTaskStatus): boolean {
  return status.status === 'completed'
    || status.status === 'failed'
    || status.status === 'aborted'
    || status.status === 'busy'
}

interface TaskWaiter {
  wake: () => void
  timer?: ReturnType<typeof setTimeout>
}

export function createMcpTaskSession(taskId = 'task'): McpTaskSession {
  let finalStatus: McpTaskStatus | null = null
  const pendingPermissions = new Map<string, McpTaskPermission>()
  const waiters = new Set<TaskWaiter>()
  const activity = createMcpTaskActivityLog()
  const streamedAssistantMessages = new Set<string>()
  const streamedReasoningMessages = new Set<string>()

  const status = (): McpTaskStatus => {
    if (finalStatus) return finalStatus
    const first = pendingPermissions.values().next().value
    return first ? { status: 'awaiting_permission', permission: first } : { status: 'running' }
  }

  const wake = (): void => {
    for (const waiter of [...waiters]) waiter.wake()
  }

  const clearPermission = (permission: { permissionId: string }): void => {
    if (pendingPermissions.delete(permission.permissionId)) wake()
  }

  const settle = (final: McpTaskStatus): McpTaskStatus => {
    if (finalStatus) return finalStatus
    activity.flush()
    finalStatus = final
    // 先通知呈现者再清空：呈现者的 resolve 清理依赖 pending 里还有该请求，
    // 否则它们的 pending 集合会残留幽灵条目（重复 present 时误判"仍在等待"）。
    for (const permission of pendingPermissions.values()) {
      clearPermission(permission)
    }
    if (final.status === 'completed') activity.publish({ type: 'completed' })
    else if (final.status === 'failed') activity.publish({
      type: 'failed', error: truncateTaskActivityText(final.error, 500)
    })
    else if (final.status === 'aborted') activity.publish({ type: 'aborted' })
    wake()
    return final
  }

  const wait = (waitMs?: number): Promise<McpTaskStatus> => {
    const current = status()
    if (isTerminalMcpTaskStatus(current) || current.status === 'awaiting_permission') {
      return Promise.resolve(current)
    }
    // 0 是协议层的非阻塞轮询语义；不得创建一个既无 timer、又无终态的 waiter。
    if (waitMs !== undefined && waitMs <= 0) return Promise.resolve(current)
    return new Promise(resolve => {
      const waiter: TaskWaiter = {
        wake: () => {
          if (waiter.timer) clearTimeout(waiter.timer)
          waiters.delete(waiter)
          resolve(status())
        }
      }
      if (waitMs !== undefined && waitMs > 0) waiter.timer = setTimeout(waiter.wake, waitMs)
      waiters.add(waiter)
    })
  }

  const snapshot = (afterCursor = 0, options: McpTaskSnapshotOptions = {}): McpTaskSnapshot => {
    return activity.snapshot(taskId, status(), afterCursor, options)
  }

  const waitForUpdate = async (
    afterCursor: number,
    waitMs?: number,
    includeReasoning = false
  ): Promise<McpTaskSnapshot> => {
    const deadline = waitMs !== undefined && waitMs > 0 ? Date.now() + waitMs : undefined
    while (true) {
      activity.flush()
      const current = status()
      const visible = activity.snapshot(taskId, current, afterCursor, {
        includeReasoning, maxEvents: 1, maxChars: 4000
      }).activities.length > 0
      if (visible || isTerminalMcpTaskStatus(current) || current.status === 'awaiting_permission'
        || (waitMs !== undefined && waitMs <= 0)) return snapshot(afterCursor, { includeReasoning })
      const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now())
      if (remaining === 0) return snapshot(afterCursor, { includeReasoning })
      await activity.waitForChange(activity.cursor(), remaining)
    }
  }

  const sink: AgentEventSink = {
    token: (_sessionId, messageId, token) => {
      streamedAssistantMessages.add(messageId)
      activity.appendText('assistant_output', token)
    },
    reasoning: (_sessionId, messageId, token) => {
      streamedReasoningMessages.add(messageId)
      activity.appendText('reasoning', token)
    },
    assistantEnd: (_sessionId, messageId, content, _toolCalls, reasoning) => {
      activity.flush()
      if (content && !streamedAssistantMessages.has(messageId)) activity.appendText('assistant_output', content)
      if (reasoning && !streamedReasoningMessages.has(messageId)) activity.appendText('reasoning', reasoning)
      activity.flush()
      streamedAssistantMessages.delete(messageId)
      streamedReasoningMessages.delete(messageId)
    },
    toolCall: (_sessionId, _messageId, toolCall) => {
      activity.flush()
      activity.publish({
        type: 'tool_call',
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        arguments: truncateTaskActivityText(toolCall.function.arguments, 2000)
      })
    },
    toolResult: (_message, toolCallId, toolName, result, isError, durationMs) => {
      activity.flush()
      activity.publish({
        type: 'tool_result', toolCallId, toolName,
        content: truncateTaskActivityText(result, 3000), isError, durationMs
      })
    },
    retry: (_sessionId, failedAttempt, maxRetries, error) => {
      activity.flush()
      activity.publish({
        type: 'retry', failedAttempt, maxRetries,
        error: truncateTaskActivityText(error.message, 500)
      })
    },
    truncated: (_sessionId, kind, reason) => {
      activity.flush()
      activity.publish({ type: 'truncated', kind, reason })
    },
    compact: (_sessionId, info) => {
      activity.flush()
      activity.publish({
        type: 'compaction', beforeTokens: info.beforeTokens, afterTokens: info.afterTokens,
        compressedCount: info.compressedCount, keptCount: info.keptCount
      })
    },
    error: (_sessionId, error) => settle({
      status: 'failed', error: truncateTaskActivityText(error.message, 500)
    }),
    aborted: () => settle({ status: 'aborted' }),
    // complete 携带整轮最终文本；运行以 complete 结束即任务交付。
    complete: (_sessionId, _messageId, content) => {
      settle({ status: 'completed', reply: content })
    }
  }

  return {
    taskId,
    sink,
    status,
    wait,
    waitForUpdate,
    snapshot,
    subscribe: activity.subscribe,
    settle,
    markPermission: permission => {
      if (finalStatus) return
      activity.flush()
      pendingPermissions.set(permission.permissionId, permission)
      activity.publish({ type: 'permission', permission })
      wake()
    },
    clearPermission,
    getPermission: permissionId => pendingPermissions.get(permissionId) ?? null
  }
}

/**
 * delegate 模式的权限呈现者：把待确认请求暴露给外部编排器（zhumora_respond
 * 可据此裁决），自身不执行任何工具、不做裁决。裁决经 PermissionBroker.respond，
 * 与 UI 呈现者共用 first-response-wins 语义。
 */
export class DelegatePermissionPresenter implements PermissionPresenter {
  private readonly pending = new Set<string>()
  private readonly session: McpTaskSession
  constructor(session: McpTaskSession) {
    this.session = session
  }

  present(request: PermissionRequest): void {
    this.pending.add(request.id)
    this.session.markPermission({
      permissionId: request.id,
      toolName: request.toolName,
      args: request.args,
      level: request.level
    })
  }

  resolve(request: PermissionRequest, _resolution: PermissionResolution): void {
    // broker 对每次 settle（批准/拒绝/超时/取消）都会回调；幂等清理。
    // PermissionRequest 的键是 id，task 侧是 permissionId——这里做字段映射。
    if (!this.pending.delete(request.id)) return
    this.session.clearPermission({ permissionId: request.id })
  }
}
