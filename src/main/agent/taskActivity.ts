import type { McpTaskPermission, McpTaskStatus } from './taskProtocol.ts'

/** 外部编排器可见的有界运行活动；它只是 Session 事件的只读投影。 */
export type McpTaskActivity =
  | { cursor: number; type: 'assistant_output'; text: string }
  | { cursor: number; type: 'reasoning'; text: string }
  | { cursor: number; type: 'tool_call'; toolCallId: string; toolName: string; arguments: string }
  | { cursor: number; type: 'tool_result'; toolCallId: string; toolName: string; content: string; isError: boolean; durationMs: number }
  | { cursor: number; type: 'permission'; permission: McpTaskPermission }
  | { cursor: number; type: 'retry'; failedAttempt: number; maxRetries: number; error: string }
  | { cursor: number; type: 'truncated'; kind: 'tool' | 'text'; reason: 'length' | 'stream' }
  | { cursor: number; type: 'compaction'; beforeTokens: number; afterTokens: number; compressedCount: number; keptCount: number }
  | { cursor: number; type: 'completed' }
  | { cursor: number; type: 'failed'; error: string }
  | { cursor: number; type: 'aborted' }

type WithoutCursor<T> = T extends unknown ? Omit<T, 'cursor'> : never
export type McpTaskActivityInput = WithoutCursor<McpTaskActivity>
export type McpTaskActivityListener = (activity: McpTaskActivity) => void

export interface McpTaskSnapshot {
  taskId: string
  /** 传回下一次 zhumora_wait 的 after_cursor；游标只在本 task 内有效。 */
  cursor: number
  status: McpTaskStatus
  activities: McpTaskActivity[]
  /** true 表示 after_cursor 早于环形缓冲，部分旧活动已被丢弃。 */
  activitiesDropped: boolean
  /** true 表示本次限额未返回完，可用本次 cursor 继续读取下一页。 */
  hasMoreActivities: boolean
}

export interface McpTaskSnapshotOptions {
  includeReasoning?: boolean
  maxEvents?: number
  maxChars?: number
}

export interface McpTaskActivityLog {
  cursor(): number
  publish(activity: McpTaskActivityInput): void
  appendText(type: 'assistant_output' | 'reasoning', value: string): void
  flush(): void
  snapshot(taskId: string, status: McpTaskStatus, afterCursor?: number, options?: McpTaskSnapshotOptions): McpTaskSnapshot
  waitForChange(afterCursor: number, waitMs?: number): Promise<void>
  subscribe(listener: McpTaskActivityListener): () => void
}

interface ActivityWaiter {
  wake: () => void
  timer?: ReturnType<typeof setTimeout>
}

const ACTIVITY_LIMIT = 80
const TEXT_CHUNK_LIMIT = 1500
const DEFAULT_SNAPSHOT_EVENTS = 24
const DEFAULT_SNAPSHOT_CHARS = 12_000
const OUTPUT_FLUSH_MS = 250

/**
 * 有界活动环与 token 分块策略。无数据库/Electron 依赖；taskProtocol 负责把
 * AgentEventSink 翻译为这里的结构事件，并仍是任务终态的 owner。
 */
export function createMcpTaskActivityLog(): McpTaskActivityLog {
  const activities: McpTaskActivity[] = []
  const listeners = new Set<McpTaskActivityListener>()
  const waiters = new Set<ActivityWaiter>()
  let cursor = 0
  let assistantBuffer = ''
  let reasoningBuffer = ''
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  const wake = (): void => {
    for (const waiter of [...waiters]) waiter.wake()
  }

  const publish = (activity: McpTaskActivityInput): void => {
    const next = { ...activity, cursor: ++cursor } as McpTaskActivity
    activities.push(next)
    if (activities.length > ACTIVITY_LIMIT) activities.splice(0, activities.length - ACTIVITY_LIMIT)
    for (const listener of [...listeners]) listener(next)
    wake()
  }

  const flush = (): void => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    publishBuffered('reasoning')
    publishBuffered('assistant_output')
  }

  const publishBuffered = (type: 'assistant_output' | 'reasoning'): void => {
    let value = type === 'assistant_output' ? assistantBuffer : reasoningBuffer
    if (type === 'assistant_output') assistantBuffer = ''
    else reasoningBuffer = ''
    while (value) {
      const text = value.slice(0, TEXT_CHUNK_LIMIT)
      value = value.slice(text.length)
      publish({ type, text })
    }
  }

  const appendText = (type: 'assistant_output' | 'reasoning', value: string): void => {
    if (!value) return
    if (type === 'assistant_output') assistantBuffer += value
    else reasoningBuffer += value
    if (assistantBuffer.length >= TEXT_CHUNK_LIMIT || reasoningBuffer.length >= TEXT_CHUNK_LIMIT) flush()
    else if (!flushTimer) flushTimer = setTimeout(flush, OUTPUT_FLUSH_MS)
  }

  const snapshot = (
    taskId: string,
    status: McpTaskStatus,
    afterCursor = 0,
    options: McpTaskSnapshotOptions = {}
  ): McpTaskSnapshot => {
    flush()
    const includeReasoning = options.includeReasoning === true
    const maxEvents = clampInt(options.maxEvents, 1, ACTIVITY_LIMIT, DEFAULT_SNAPSHOT_EVENTS)
    const maxChars = clampInt(options.maxChars, 4000, 50_000, DEFAULT_SNAPSHOT_CHARS)
    const oldestCursor = activities[0]?.cursor ?? cursor + 1
    const eligible = activities.filter(activity => activity.cursor > afterCursor
      && (includeReasoning || activity.type !== 'reasoning'))
    let usedChars = 0
    const bounded: McpTaskActivity[] = []
    for (const activity of eligible) {
      const size = JSON.stringify(activity).length
      if (bounded.length >= maxEvents || usedChars + size > maxChars) break
      bounded.push(activity)
      usedChars += size
    }
    return {
      taskId,
      cursor: bounded.length < eligible.length ? (bounded.at(-1)?.cursor ?? afterCursor) : cursor,
      status,
      activities: bounded,
      activitiesDropped: afterCursor < oldestCursor - 1,
      hasMoreActivities: bounded.length < eligible.length
    }
  }

  const waitForChange = (afterCursor: number, waitMs?: number): Promise<void> => {
    flush()
    if (cursor > afterCursor || (waitMs !== undefined && waitMs <= 0)) return Promise.resolve()
    return new Promise(resolve => {
      const waiter: ActivityWaiter = {
        wake: () => {
          if (waiter.timer) clearTimeout(waiter.timer)
          waiters.delete(waiter)
          resolve()
        }
      }
      if (waitMs !== undefined && waitMs > 0) waiter.timer = setTimeout(waiter.wake, waitMs)
      waiters.add(waiter)
    })
  }

  return {
    cursor: () => cursor,
    publish,
    appendText,
    flush,
    snapshot,
    waitForChange,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export function truncateTaskActivityText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n…[truncated]`
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}
