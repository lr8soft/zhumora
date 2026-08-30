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
// finish_reason 是区分"模型真正完成本轮"与"响应被单次输出上限
// （max_tokens）中途静默截断（length）"的关键信号 ——
// 这是"工作没做完却无报错停止"的根因（消费方见 runner.ts）。
//
// 本模块不依赖 electron，可直接用 node 运行单元测试（tests/truncation.test.ts）。
// ============================================================
import type { ToolCall } from '../../shared/types'

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
  /** 停止原因（以最后一个非空 finish_reason 为准） */
  finishReason?: string
}

/**
 * 从 delta 中提取思考内容增量（reasoning_content / reasoning 字段）。
 * 不同推理模型的后端字段名不同：
 * - DeepSeek-R1 / 豆包 / Kimi / 多数 OpenAI 兼容网关 → reasoning_content
 * - OpenAI o-series 部分端点 / Ollama → reasoning
 * 非字符串（如 o-series 的对象形 signature 块）一律忽略。
 * 思考内容仅供 UI 展示：不进正文、不回传 LLM 上下文。
 */
export function extractReasoningDelta(delta: any): string {
  if (typeof delta?.reasoning_content === 'string') return delta.reasoning_content
  if (typeof delta?.reasoning === 'string') return delta.reasoning
  return ''
}

/** 创建空聚合器 */
export function createStreamAccumulator(): StreamAccumulator {
  return { content: '', toolCalls: new Map() }
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
 * '[DONE]'、无法解析的载荷、空载荷一律忽略（部分后端会发 keep-alive 或非 JSON 行）。
 */
export function applySseData(acc: StreamAccumulator, data: string): SseApplyResult {
  const result: SseApplyResult = { token: '', reasoning: '', emitted: false }
  if (data === '[DONE]') return result

  let json: any
  try {
    json = JSON.parse(data)
  } catch {
    return result
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
  if (choice?.finish_reason) {
    acc.finishReason = String(choice.finish_reason)
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
