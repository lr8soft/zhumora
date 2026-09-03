// ============================================================
// Agent IPC 事件 → 会话消息缓存的纯归并逻辑（reducer）
//
// AGENTS.MD 约束："Agent IPC 事件归并逻辑应是可测试的 reducer，
// 不继续堆进 App.tsx"。这里所有函数都满足：
// - 纯函数：输入当前会话消息数组 + 事件载荷 → 返回新数组（或原引用）；
// - 只按 main 进程分配的权威 messageId 定位消息，绝不按位置猜测、
//   不回退到"最后一条 streaming 消息"（找不到就追加/忽略，语义见各函数）；
// - 不触碰 Zustand、不读全局状态 → 可直接用 node 跑单测。
//
// App.tsx 负责订阅 IPC、调用这些 reducer 写 store，以及 token 批量缓冲。
// ============================================================
import type { UIMessage, ToolCall } from '../../shared/types'

/** assistant 流式增量（flush 时一次性并入目标消息） */
export interface TokenDelta {
  msgId: string
  content: string
  reasoning: string
}

/**
 * phase=start：把 thinking 占位替换为正式流式消息（main 已在首个 token 前
 * 发出 start，占位可能已携带思考增量，替换时保留——防御事件乱序）。
 * 无占位时按 ID 去重追加。
 */
export function applyAssistantStart(sessionId: string, messageId: string, messages: UIMessage[], now: number): UIMessage[] {
  const idx = messages.findIndex(x => x.status === 'thinking')
  if (idx >= 0) {
    const next = [...messages]
    next[idx] = {
      id: messageId,
      sessionId,
      role: 'assistant',
      content: '',
      reasoning: messages[idx].reasoning || undefined,
      timestamp: now,
      status: 'streaming'
    }
    return next
  }
  if (messages.some(x => x.id === messageId)) return messages
  return [...messages, {
    id: messageId,
    sessionId,
    role: 'assistant',
    content: '',
    timestamp: now,
    status: 'streaming'
  }]
}

/**
 * phase=end：本轮 LLM 调用收尾。
 * - 已有消息：用 end 事件的权威 content/reasoning 覆盖；纯工具轮（无文本、
 *   无思考、无工具调用）把 start 创建的空气泡直接移除（工具行由 tool_call
 *   事件渲染，避免空气泡）；有工具调用 → status=pending（等待工具结果）。
 * - 消息不存在（如 renderer 重启错过 start）：非空时补建。
 */
export function applyAssistantEnd(
  sessionId: string,
  messageId: string,
  content: string,
  toolCalls: ToolCall[],
  reasoning: string | undefined,
  messages: UIMessage[],
  now: number
): UIMessage[] {
  const existingIdx = messages.findIndex(x => x.id === messageId)
  if (existingIdx >= 0) {
    const finalContent = content || messages[existingIdx].content
    if (!finalContent && !reasoning && !messages[existingIdx].reasoning && toolCalls.length === 0) {
      return messages.filter((_, i) => i !== existingIdx)
    }
    const updated = [...messages]
    updated[existingIdx] = {
      ...updated[existingIdx],
      content: finalContent,
      reasoning: reasoning || updated[existingIdx].reasoning,
      toolCalls: toolCalls.length > 0 ? toolCalls : updated[existingIdx].toolCalls,
      status: toolCalls.length > 0 ? 'pending' : 'done'
    }
    return updated
  }
  if (!content && !reasoning && toolCalls.length === 0) return messages
  return [...messages, {
    id: messageId,
    sessionId,
    role: 'assistant',
    content,
    reasoning,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    timestamp: now,
    status: toolCalls.length > 0 ? 'pending' : 'done'
  }]
}

/**
 * tool_call 事件：挂到对应 assistant 消息上（按 ID 找不到则补建 pending 消息）。
 * 同时移除 thinking 占位 —— 工具调用已经开始，占位使命完成。
 */
export function applyToolCallEvent(sessionId: string, messageId: string, toolCall: ToolCall, messages: UIMessage[], now: number): UIMessage[] {
  const next = messages.filter(x => x.status !== 'thinking')
  const idx = next.findIndex(x => x.id === messageId)
  if (idx >= 0) {
    const calls = next[idx].toolCalls || []
    if (!calls.some(call => call.id === toolCall.id)) {
      next[idx] = { ...next[idx], toolCalls: [...calls, toolCall], status: 'pending' }
    }
    return next
  }
  next.push({
    id: messageId,
    sessionId,
    role: 'assistant',
    content: '',
    toolCalls: [toolCall],
    timestamp: now,
    status: 'pending'
  })
  return next
}

/** tool_result 事件：以 main 的持久化 id 追加一条 tool 消息 */
export function applyToolResultEvent(sessionId: string, messageId: string, toolCallId: string, toolName: string, result: string, isError: boolean, messages: UIMessage[], now: number): UIMessage[] {
  return [...messages, {
    id: messageId,
    sessionId,
    role: 'tool',
    content: result,
    toolCallId,
    toolName,
    timestamp: now,
    status: isError ? 'error' : 'done'
  }]
}

/**
 * 批量并入 token/reasoning 增量（32ms 节拍 flush 调用）。
 * 只按 msgId 精确命中；thinking/streaming 收到增量转 streaming，
 * done/error 保持终态。无任何命中时返回原引用（不触发重渲染）。
 */
export function applyTokenDeltas(messages: UIMessage[], deltas: TokenDelta[]): UIMessage[] {
  const relevant = deltas.filter(d => d.content || d.reasoning)
  if (relevant.length === 0) return messages
  const next = [...messages]
  let changed = false
  for (const d of relevant) {
    const idx = next.findIndex(m => m.id === d.msgId)
    if (idx < 0) continue
    const m = next[idx]
    next[idx] = {
      ...m,
      content: d.content ? m.content + d.content : m.content,
      reasoning: d.reasoning ? (m.reasoning || '') + d.reasoning : m.reasoning,
      status: m.status === 'thinking' || m.status === 'streaming' ? 'streaming' : m.status
    }
    changed = true
  }
  return changed ? next : messages
}
