import type { UIMessage } from '../../shared/types.ts'
import { toolPresentationRevision } from '../../shared/toolPresentation.ts'

export interface TimelineRetryStatus {
  failedAttempt: number
  maxRetries: number
}

export interface MessageTimelineRow {
  key: `message:${string}`
  type: 'message'
  message: UIMessage
  toolStatuses?: Record<string, 'done' | 'error'>
  toolResults?: Record<string, { content: string; isError: boolean }>
  toolRevision: string
  retryStatus?: TimelineRetryStatus
}

export interface CompactionTimelineRow {
  key: `compaction:${string}`
  type: 'compaction'
}

export interface RetryTimelineRow {
  key: `retry:${string}`
  type: 'retry'
  status: TimelineRetryStatus
}

export type TimelineRow = MessageTimelineRow | CompactionTimelineRow | RetryTimelineRow

interface TimelineOptions {
  sessionId: string
  compaction?: { upToMessageId: string } | null
  retryStatus?: TimelineRetryStatus
  isRunning: boolean
}

/**
 * 将权威消息数组投影为展示行。工具结果合并、压缩标记和重试行只存在于
 * renderer 投影，不改变消息顺序、ID 或持久化内容。
 */
export function buildTimelineRows(messages: readonly UIMessage[], options: TimelineOptions): TimelineRow[] {
  const referencedToolCallIds = new Set<string>()
  const toolMessages = new Map<string, UIMessage>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls || []) {
        if (toolCall.id) referencedToolCallIds.add(toolCall.id)
      }
    } else if (message.role === 'tool' && message.toolCallId) {
      toolMessages.set(message.toolCallId, message)
    }
  }

  const rows: TimelineRow[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    const mergedToolResult = message.role === 'tool'
      && !!message.toolCallId
      && referencedToolCallIds.has(message.toolCallId)

    if (!mergedToolResult) rows.push(buildMessageRow(message, toolMessages, options.retryStatus))

    if (options.compaction?.upToMessageId === message.id && index < messages.length - 1) {
      rows.push({ key: `compaction:${message.id}`, type: 'compaction' })
    }
  }

  if (options.retryStatus && options.isRunning && !messages.some(message => message.status === 'thinking')) {
    rows.push({ key: `retry:${options.sessionId}`, type: 'retry', status: options.retryStatus })
  }

  return rows
}

function buildMessageRow(
  message: UIMessage,
  toolMessages: ReadonlyMap<string, UIMessage>,
  retryStatus: TimelineRetryStatus | undefined
): MessageTimelineRow {
  const toolStatuses: Record<string, 'done' | 'error'> = {}
  const toolResults: Record<string, { content: string; isError: boolean }> = {}
  const revisions: Record<string, string> = {}

  for (const toolCall of message.toolCalls || []) {
    const result = toolMessages.get(toolCall.id)
    if (!result) continue
    const isError = result.status === 'error'
    toolStatuses[toolCall.id] = isError ? 'error' : 'done'
    toolResults[toolCall.id] = { content: result.content, isError }
    revisions[toolCall.id] = `${result.id}:${result.status || 'done'}`
  }

  return {
    key: `message:${message.id}`,
    type: 'message',
    message,
    toolStatuses: Object.keys(toolStatuses).length > 0 ? toolStatuses : undefined,
    toolResults: Object.keys(toolResults).length > 0 ? toolResults : undefined,
    toolRevision: toolPresentationRevision(message.toolCalls, revisions),
    retryStatus: message.status === 'thinking' ? retryStatus : undefined
  }
}
