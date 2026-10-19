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
 * 思考内容仅供 UI 展示：不进正文、不回传 LLM 上下文。
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
  try {
    json = JSON.parse(data)
  } catch {
    throw new ProviderStreamError('payload')
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ProviderStreamError('payload')
  if (json.error) throw new ProviderStreamError('provider', json.error, {
    ...context, requestId: json.request_id ?? context?.requestId
  })
  if (!Array.isArray(json.choices)) throw new ProviderStreamError('payload')
  // Requests select one completion (n=1). Never merge a different choice into its terminal state.
  if (json.choices.length > 1 || (json.choices[0]?.index != null && json.choices[0].index !== 0)) {
    throw new ProviderStreamError('payload')
  }

  // 用量（include_usage 开启时由末块携带，该块 choices 常为空数组）
  if (json.usage) {
    acc.usage = {
      prompt_tokens: json.usage.prompt_tokens || 0,
      completion_tokens: json.usage.completion_tokens || 0,
      total_tokens: json.usage.total_tokens || 0
    }
  }

  const choice = json.choices?.[0]
  if (json.choices.length && (!choice || typeof choice !== 'object' || Array.isArray(choice))) {
    throw new ProviderStreamError('payload')
  }
  if (choice && !choice.delta && !choice.finish_reason) throw new ProviderStreamError('payload')
  if (choice && ('message' in choice || (choice.delta != null
    && (typeof choice.delta !== 'object' || Array.isArray(choice.delta))))) throw new ProviderStreamError('payload')
  if (choice?.finish_reason != null && (typeof choice.finish_reason !== 'string' || !choice.finish_reason.trim())) {
    throw new ProviderStreamError('payload')
  }
  if (choice?.delta?.content != null && typeof choice.delta.content !== 'string') throw new ProviderStreamError('payload')
  if (choice?.delta?.tool_calls != null && !Array.isArray(choice.delta.tool_calls)) throw new ProviderStreamError('payload')
  if (acc.finishReason && (choice?.delta?.content || extractReasoningDelta(choice?.delta)
    || choice?.delta?.tool_calls?.length || (choice?.finish_reason && choice.finish_reason !== acc.finishReason))) {
    throw new ProviderStreamError('payload')
  }
  if (choice?.finish_reason) {
    acc.finishReason = choice.finish_reason
  }

  const delta = choice?.delta
  if (!delta) return result

  // 思考内容增量（仅 UI 展示，不聚合进 content）
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
  if (delta.tool_calls) {
    result.emitted = true
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0
      if (!acc.toolCalls.has(idx)) {
        acc.toolCalls.set(idx, {
          id: tc.id || '',
          type: 'function',
          function: { name: '', arguments: '' }
        })
      }
      const existing = acc.toolCalls.get(idx)!
      if (tc.id) existing.id = tc.id
      if (tc.function?.name) existing.function.name += tc.function.name
      if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
    }
  }

  return result
}

/** 从聚合器读出最终结果 */
export function accumulateResult(acc: StreamAccumulator): {
  content: string
  toolCalls: ToolCall[]
  usage?: TokenUsage
  finishReason?: string
} {
  return {
    content: acc.content,
    toolCalls: Array.from(acc.toolCalls.values()),
    usage: acc.usage,
    finishReason: acc.finishReason
  }
}

// ============================================================
// SSE 行缓冲 — 网络块 → 完整行
// ============================================================

/**
 * 流式响应的行切分器。
 * feed() 把新到的网络块追加进内部缓冲，按 \n 切出完整行回调；
 * 末尾未以 \n 结束的不完整行留在缓冲，等下一个块补齐。
 * flush() 在流结束时把剩余内容全部按行回调 —— 部分后端最后一个
 * 块（常携带 finish_reason / usage）不带结尾换行，不 flush 会丢信号。
 */
export class SseLineBuffer {
  private buffer = ''

  /** 追加一个网络块，回调所有已完整的行 */
  feed(chunk: string, onLine: (line: string) => void): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    for (const line of lines) onLine(line)
  }

  /** 流结束：回调剩余内容（可能为空） */
  flush(onLine: (line: string) => void): void {
    const rest = this.buffer
    this.buffer = ''
    if (rest !== '') onLine(rest)
  }
}
