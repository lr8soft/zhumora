import type { ToolCall, UIMessage } from '../../shared/types.ts'
import { toolChainRevision, toolPresentationRevision } from '../../shared/toolPresentation.ts'

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

/** 工具链节点：一次 toolCall（跨进程事件已按 id 携带全量信息） */
export interface ToolChainNode {
  toolCallId: string
  name: string
  arguments: string
  status: 'running' | 'done' | 'error'
  content?: string
  isError?: boolean
}

export interface ToolChainTimelineRow {
  key: `chain:${string}`
  type: 'chain'
  /** 链的成员（纯工具轮 assistant 消息），顺序即历史顺序 */
  members: UIMessage[]
  /** 按历史顺序展开的节点（一轮并行 tool_calls 占多格） */
  nodes: ToolChainNode[]
  /** 成员结果落位/状态变化的修订标记，供 React.memo 比较 */
  revision: string
}

export type TimelineRow =
  | MessageTimelineRow
  | CompactionTimelineRow
  | RetryTimelineRow
  | ToolChainTimelineRow

interface TimelineOptions {
  sessionId: string
  compaction?: { upToMessageId: string } | null
  retryStatus?: TimelineRetryStatus
  isRunning: boolean
}

/**
 * 将权威消息数组投影为展示行。工具结果合并、工具链聚合、压缩标记和重试行
 * 只存在于 renderer 投影，不改变消息顺序、ID 或持久化内容。
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

  const boundary = options.compaction?.upToMessageId ?? null
  const rows: TimelineRow[] = []
  let chain: UIMessage[] = []
  // 压缩标记必须紧跟边界消息的展示行。边界消息本身可能被合并（tool 结果）
  // 或聚进链（纯工具轮），不单独成行 —— 此时把标记位挂起，在承载它的行
  // 之后补插压缩行。边界落在链中间时，链在此断开（前段 + 标记 + 后段）。
  let pendingCompaction = false

  const emitCompaction = () => {
    rows.push({ key: `compaction:${boundary}`, type: 'compaction' })
    pendingCompaction = false
  }

  const flushChain = () => {
    if (chain.length > 0) {
      rows.push(buildChainRow(chain, toolMessages))
      chain = []
    }
    if (pendingCompaction) emitCompaction()
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    const isBoundary = boundary !== null && message.id === boundary && index < messages.length - 1
    const mergedToolResult = message.role === 'tool'
      && !!message.toolCallId
      && referencedToolCallIds.has(message.toolCallId)

    if (mergedToolResult) {
      if (isBoundary) pendingCompaction = true
      continue
    }

    // 纯工具轮（有 tool_calls、无正文、无思考）连续出现时聚合为一条链；
    // 中间被任何非纯工具轮消息打断则断开。被引用的 tool 结果消息（上面已
    // continue）不参与打断判定 —— 历史里 tool 消息穿插在 assistant 组之间不拆链。
    const isPureToolRound = message.role === 'assistant'
      && (message.toolCalls?.length ?? 0) > 0
      && !message.content
      && !message.reasoning

    if (isPureToolRound) {
      chain.push(message)
      if (isBoundary) {
        // 边界是链成员：标记紧跟本条链行，后续纯工具轮另起新链
        pendingCompaction = true
        flushChain()
      }
      continue
    }

    flushChain()
    rows.push(buildMessageRow(message, toolMessages, options.retryStatus))
    if (isBoundary) emitCompaction()
  }

  flushChain()

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

/**
 * 把一组 toolCall 构建为链节点（无结果 = running）。
 * 两个调用方共用，保证节点语义一致：
 * - 跨轮工具链行（buildChainRow，结果来自 toolMessages 映射）
 * - 单条 assistant 消息内的并行 tool_calls（MessageBubble，结果来自 row 聚合表）
 */
export function buildToolChainNodes(
  toolCalls: readonly ToolCall[],
  statuses: Readonly<Record<string, 'done' | 'error'>> | undefined,
  results: Readonly<Record<string, { content: string; isError: boolean }>> | undefined
): ToolChainNode[] {
  const nodes: ToolChainNode[] = []
  for (const call of toolCalls) {
    if (!call.id) continue
    const status = statuses?.[call.id]
    const result = results?.[call.id]
    const isError = result?.isError || status === 'error'
    nodes.push({
      toolCallId: call.id,
      name: call.function.name,
      arguments: call.function.arguments || '',
      status: status === 'done' ? 'done' : status === 'error' ? 'error' : 'running',
      content: result?.content,
      isError
    })
  }
  return nodes
}

/**
 * 连续纯工具轮 → 一条链行。key 取首个成员 id：成员追加只走 revision
 * 变化重渲染，key 保持稳定（否则虚拟列表重建行，丢失展开态与横向滚动位置）。
 */
function buildChainRow(
  members: readonly UIMessage[],
  toolMessages: ReadonlyMap<string, UIMessage>
): ToolChainTimelineRow {
  const statuses: Record<string, 'done' | 'error'> = {}
  const results: Record<string, { content: string; isError: boolean }> = {}
  const revisions: Record<string, string> = {}

  for (const member of members) {
    for (const call of member.toolCalls || []) {
      if (!call.id) continue
      const result = toolMessages.get(call.id)
      if (!result) continue
      const isError = result.status === 'error'
      statuses[call.id] = isError ? 'error' : 'done'
      results[call.id] = { content: result.content, isError }
      revisions[call.id] = `${result.id}:${result.status || 'done'}`
    }
  }

  const nodes = members.flatMap(member =>
    buildToolChainNodes(member.toolCalls || [], statuses, results)
  )

  return {
    key: `chain:${members[0].id}`,
    type: 'chain',
    members: [...members],
    nodes,
    revision: toolChainRevision(
      members.map(member => ({ id: member.id, toolCalls: member.toolCalls as ToolCall[] })),
      revisions
    )
  }
}
