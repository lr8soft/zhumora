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
   * 单轮输出达到 max_tokens 上限被截断（finish_reason = length）。
   * 通知前端展示"输出被截断"提示条 —— 这是"工作没做完却无报错停止"
   * 的根因场景，必须让用户可见（对齐 opencode / Cline 的 finish_reason 处理）。
   * 截断的文本/工具调用已按原样保留，runner 会自动引导模型续写或重试工具调用。
   */
  onTruncated?: (kind: 'tool' | 'text') => void
}

/** streamChat 一次调用的结果 + 本轮思考内容（思考内容不进入模型上下文） */
export interface RoundResult {
  content: string
  toolCalls: ToolCall[]
  usage: TokenUsage | null | undefined
  finishReason: string | undefined
  reasoning: string
}
