// ============================================================
// Agent 事件回调契约 + 单轮 LLM 调用结果类型
//
// 独立于 runner：runner 触发这些回调，turnEffects 消费它们执行副作用，
// IPC 层（agentCallbacks.ts）实现它们 —— 三方依赖契约而非 runner 本身。
// ============================================================
import type { ToolCall } from '../../shared/types'
import type { TokenUsage } from '../llm/provider'

export interface AgentEventCallbacks {
  /** LLM 流式 token */
  onToken?: (token: string) => void
  /** LLM 流式思考内容（reasoning_content；仅供 UI 展示，不回传模型） */
  onReasoningToken?: (token: string) => void
  /** LLM 请求了工具调用 */
  onToolCall?: (toolCall: ToolCall, assistantMessageId: string | null) => void
  /** 工具执行完成。返回该 tool 消息落库后的 id（供压缩边界定位），未落库返回 null */
  onToolResult?: (toolCallId: string, toolName: string, result: string, isError: boolean, durationMs: number) => string | null
  /** 一轮 LLM 调用完成（可能继续循环或结束）。返回该 assistant 消息落库后的 id，未落库返回 null */
  onAssistantMessage?: (content: string, toolCalls: ToolCall[], reasoning?: string) => string | null
  /** Token 用量回调 */
  onTokenUsage?: (usage: TokenUsage, model: string) => void
  /** 整个对话完成 */
  onComplete?: () => void
  /** 出错 */
  onError?: (error: Error) => void
  /** LLM 网络失败，正在自动重试 */
  onRetry?: (failedAttempt: number, maxRetries: number, error: Error) => void
  /** 上下文压缩完成（通知前端展示提示 + 更新压缩标记位置） */
  onCompact?: (info: { beforeTokens: number; afterTokens: number; compressedCount: number; keptCount: number; boundaryMessageId?: string }) => void
  /**
   * 单轮输出不完整（达到 max_tokens 上限 / 流中途网络断开）。
   * 通知前端展示提示条 —— 这是"工作没做完却无报错停止"
   * 的根因场景，必须让用户可见（对齐 opencode / Cline 的 finish_reason 处理）。
   * 部分内容已按原样保留，runner 会自动引导模型续写或重试工具调用。
   * @param kind   'tool' = 本轮含工具调用（参数残缺）；'text' = 纯文本
   * @param reason 'length' = 达到 max_tokens 上限；'stream' = 流中途网络断开
   */
  onTruncated?: (kind: 'tool' | 'text', reason: 'length' | 'stream') => void
}

/** streamChat 一次调用的结果 + 本轮思考内容（思考内容不进入模型上下文） */
export interface RoundResult {
  content: string
  toolCalls: ToolCall[]
  usage: TokenUsage | null | undefined
  finishReason: string | undefined
  reasoning: string
  /**
   * 流式响应中途被网络断开（已输出部分内容后连接失败）。
   * 与 finish_reason=length 的"输出上限截断"是两种不同的中断，
   * 但恢复策略同构：保留部分文本、引导模型续写/重发工具调用。
   * 详见 provider.streamChat 与 turnDecision。
   */
  streamInterrupted?: boolean
}
