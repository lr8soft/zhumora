// ============================================================
// SSE 流块聚合 — 纯模块
//
// OpenAI 兼容流式接口（stream: true）把一次响应拆成若干 SSE chunk：
// - delta.content 文本增量
// - delta.tool_calls 工具调用分片（id / function.name / function.arguments
//   都按 index 分片到达，需拼接）
// - 最后一个 chunk 携带 usage（stream_options.include_usage=true 时；
//   该 chunk 的 choices 常为空数组）
// - 最后一个含内容的 chunk 里 choices[0].finish_reason 是停止原因：
//   stop / tool_calls / length / content_filter …
//
// finish_reason 描述生成如何停止；是否有正文/工具交付由 agent 状态机判断。
//
// 本模块不依赖 electron，可直接用 node 运行单元测试（tests/truncation.test.ts）。
// ============================================================
import type { ToolCall } from '../../shared/types'
import { ProviderStreamError } from './streamErrors.ts'
import type { StreamErrorContext } from './providerErrorDetails.ts'
import type { GenerationMetadata } from '../../shared/generation.ts'
import { applyToolDeltas } from './toolCallAccumulator.ts'

/** 单次 LLM 调用的 token 用量 */
export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/** 流块聚合状态（每次流式尝试一个） */
export interface StreamAccumulator {
  /** 本轮完整文本（delta.content 拼接） */
  content: string
  /** 工具调用（按 index 组装） */
  toolCalls: Map<number, ToolCall>
  /** 用量（末块携带） */
  usage?: TokenUsage
  /** 选定 choice 的停止原因；其后只允许 usage 等无输出尾块。 */
  finishReason?: string
  done: boolean
  refusal?: string
  generation?: GenerationMetadata
}

/**
 * 从 delta 中提取思考内容增量（reasoning_content / reasoning 字段）。
 * 不同推理模型的后端字段名不同：
 * - DeepSeek-R1 / 豆包 / Kimi / SGLang / llama.cpp / 多数 OpenAI 兼容网关 → reasoning_content
 * - vLLM（已由 reasoning_content 改名）/ OpenAI o-series 部分端点 / Ollama → reasoning
 * 非字符串（如 o-series 的对象形 signature 块）一律忽略。
 *
 * 取"第一个非空字符串"而不是"第一个字符串"：vLLM 改名后官方明确警告，客户端
 * 读旧字段会静默拿到空值；同时吐两个键的版本里，空串不能遮蔽另一个键的真实内容。
 * 思考内容不混入正文；是否回传由 Provider/model 绑定的请求投影策略决定。
 */
export function extractReasoningDelta(delta: any): string {
  for (const candidate of [delta?.reasoning_content, delta?.reasoning]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return ''
}

/** 创建空聚合器 */
export function createStreamAccumulator(): StreamAccumulator {
  return { content: '', toolCalls: new Map(), done: false }
}

/** 应用单个 chunk 的结果 */
export interface SseApplyResult {
  /** 本 chunk 的文本增量（供调用方实时推送流式回调；无增量为空串） */
  token: string
  /** 本 chunk 的思考内容增量（reasoning_content；供调用方推送 onReasoningToken；无增量为空串） */
  reasoning: string
  /** 本 chunk 是否包含可见输出（文本、思考或工具调用）—— 调用方据此
   *  置"已输出"标记，避免重试时向 UI 重复推流 */
  emitted: boolean
}

/**
 * 把一条 SSE data 载荷（"data:" 之后的 JSON 字符串）应用到聚合器。
 * 空 data 是心跳；DONE 只终结传输。错误/损坏 data 不能被忽略后当作成功。
 */
export function applySseData(acc: StreamAccumulator, data: string, context?: StreamErrorContext): SseApplyResult {
  const result: SseApplyResult = { token: '', reasoning: '', emitted: false }
  if (acc.done || !data) return result
  if (data === '[DONE]') { acc.done = true; return result }

  let json: any
  const invalidPayload = () => new ProviderStreamError('payload', { reason: 'Malformed chat completion chunk', response: json }, context)
  try {
    json = JSON.parse(data)
  } catch {
    throw new ProviderStreamError('payload', { reason: 'Invalid SSE JSON', data }, context)
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw invalidPayload()
  if (json.error != null) throw new ProviderStreamError('provider', json.error, {
    ...context, envelope: json, responseBody: data, requestId: json.request_id ?? context?.requestId
  })
  if (!Array.isArray(json.choices)) throw invalidPayload()
  if (typeof json.model === 'string') acc.generation = { version: 1, status: 'complete', ...acc.generation, returnedModel: json.model }
  if (json.id != null) {
    if (typeof json.id !== 'string' || (acc.generation?.responseId && json.id !== acc.generation.responseId)) {
      throw new ProviderStreamError('payload', { reason: 'Completion identity changed', id: json.id })
    }
    acc.generation = { version: 1, status: 'complete', ...acc.generation, responseId: json.id }
  }
  // Requests select one completion (n=1). Never merge a different choice into its terminal state.
  if (json.choices.length > 1 || (json.choices[0]?.index != null && json.choices[0].index !== 0)) {
    throw invalidPayload()
  }

  // 用量（include_usage 开启时由末块携带，该块 choices 常为空数组）
  if (json.usage) {
    const fields = ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const
    if (fields.every(key => typeof json.usage[key] === 'number' && Number.isFinite(json.usage[key]) && json.usage[key] >= 0)) {
      acc.usage = { prompt_tokens: json.usage.prompt_tokens, completion_tokens: json.usage.completion_tokens, total_tokens: json.usage.total_tokens }
    } else acc.generation = { version: 1, status: 'complete', ...acc.generation,
      warnings: [...(acc.generation?.warnings ?? []), 'Provider usage was invalid or incomplete; it was not counted as zero.'] }
  }

  const choice = json.choices?.[0]
  if (json.choices.length && (!choice || typeof choice !== 'object' || Array.isArray(choice))) {
    throw invalidPayload()
  }
  if (choice && !choice.delta && !choice.finish_reason) throw invalidPayload()
  if (choice && ('message' in choice || (choice.delta != null
    && (typeof choice.delta !== 'object' || Array.isArray(choice.delta))))) throw invalidPayload()
  if (choice?.finish_reason != null && (typeof choice.finish_reason !== 'string' || !choice.finish_reason.trim())) {
    throw invalidPayload()
  }
  if (choice?.delta?.content != null && typeof choice.delta.content !== 'string') throw invalidPayload()
  if (choice?.delta?.tool_calls != null && !Array.isArray(choice.delta.tool_calls)) throw invalidPayload()
  if (choice?.delta?.refusal != null && typeof choice.delta.refusal !== 'string') throw invalidPayload()
  if (choice?.delta?.audio != null) throw new ProviderStreamError('payload', { reason: 'Unsupported audio output', response: json }, context)
  if (choice?.delta?.function_call != null) {
    throw new ProviderStreamError('payload', { reason: 'Unsupported legacy function_call', fragment: choice.delta.function_call })
  }
  if (acc.finishReason && (choice?.delta?.content || extractReasoningDelta(choice?.delta)
    || choice?.delta?.refusal || choice?.delta?.tool_calls?.length || (choice?.finish_reason && choice.finish_reason !== acc.finishReason))) {
    throw invalidPayload()
  }
  if (choice?.finish_reason) {
    acc.finishReason = choice.finish_reason
    acc.generation = { version: 1, status: 'complete', ...acc.generation, finishReason: choice.finish_reason,
      ...(typeof choice.matched_stop === 'string' || typeof choice.matched_stop === 'number'
        ? { matchedStop: choice.matched_stop } : {}) }
  }

  const delta = choice?.delta
  if (!delta) return result
  if (delta.refusal) {
    acc.refusal = (acc.refusal || '') + delta.refusal
    result.emitted = true
  }

  // 思考内容增量独立于 content；历史回传策略在请求边界执行。
  const reasoning = extractReasoningDelta(delta)
  if (reasoning) {
    result.reasoning = reasoning
    result.emitted = true
  }

  // 文本增量
  if (delta.content) {
    result.token = delta.content
    result.emitted = true
    acc.content += delta.content
  }

  // 工具调用增量（分片到达，按 index 拼接）
  if (delta.tool_calls) result.emitted = applyToolDeltas(acc.toolCalls, delta.tool_calls) || result.emitted

  return result
}

/** 从聚合器读出最终结果 */
export function accumulateResult(acc: StreamAccumulator): {
  content: string
  toolCalls: ToolCall[]
  usage?: TokenUsage
  finishReason?: string
  refusal?: string
  generation?: GenerationMetadata
} {
  return {
    content: acc.content,
    toolCalls: Array.from(acc.toolCalls.values()),
    usage: acc.usage,
    finishReason: acc.finishReason,
    ...(acc.refusal ? { refusal: acc.refusal } : {}),
    ...(acc.generation ? { generation: acc.generation } : {})
  }
}

// ============================================================
// SSE 行缓冲 — 网络块 → 完整行
// ============================================================

/**
 * 流式响应的行切分器。
 * feed() 支持 LF、CRLF、CR；跨块的半行留在缓冲，等待后续块。
 * flush() 在流结束时把剩余内容全部按行回调 —— 部分后端最后一个
 * 块（常携带 finish_reason / usage）不带结尾换行，不 flush 会丢信号。
 */
export class SseLineBuffer {
  private buffer = ''
  private skipLf = false
  private readonly maxLineChars: number

  constructor(maxLineChars = 8 * 1024 * 1024) { this.maxLineChars = maxLineChars }

  /** 追加一个网络块，回调所有已完整的行 */
  feed(chunk: string, onLine: (line: string) => void): void {
    let start = 0
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i]
      if (this.skipLf) {
        this.skipLf = false
        if (char === '\n') { start = i + 1; continue }
      }
      if (char === '\r' || char === '\n') {
        this.checkLength(this.buffer.length + i - start)
        onLine(this.buffer + chunk.slice(start, i))
        this.buffer = ''
        start = i + 1
        this.skipLf = char === '\r'
      }
    }
    this.checkLength(this.buffer.length + chunk.length - start)
    this.buffer += chunk.slice(start)
  }

  /** 流结束：回调剩余内容（可能为空） */
  flush(onLine: (line: string) => void): void {
    const rest = this.buffer
    this.buffer = ''
    if (rest !== '') onLine(rest)
  }

  private checkLength(length: number): void {
    if (length > this.maxLineChars) throw new ProviderStreamError('payload', { reason: 'SSE line exceeds response limit', limit: this.maxLineChars })
  }
}
