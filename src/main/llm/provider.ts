// ============================================================
// LLM Provider 适配器 — 统一 OpenAI 兼容接口
// 天然支持任意端点：OpenAI / Anthropic(兼容层) / Ollama / vLLM
// ============================================================
import type { ChatMessage, ProviderConfig, ToolCall, ToolDefinition } from '../../shared/types'
import { log } from './logger'
import { getFetch } from '../net/fetch'
import { HttpError, getMaxRetries, isRetriableError, withRetry } from '../net/retry'
import {
  createStreamAccumulator, applySseData, accumulateResult, SseLineBuffer, type TokenUsage
} from './sseAccumulator'

export type { TokenUsage }

export interface StreamCallbacks {
  onToken?: (token: string) => void
  onComplete?: (fullText: string, toolCalls: ToolCall[]) => void
  onError?: (error: Error) => void
  /** 网络失败，正在自动重试（failedAttempt = 已失败次数，maxRetries = -1 表示无限） */
  onRetry?: (failedAttempt: number, maxRetries: number, error: Error) => void
}

export interface CompletionParams {
  messages: ChatMessage[]
  model?: string
  tools?: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
  signal?: AbortSignal
}

/** 流空闲超时：120s 无任何数据块则中止（防止半开连接永久挂起；未输出时该错误可重试） */
const STREAM_IDLE_TIMEOUT_MS = 120_000

/** 单次流式尝试的结果 */
interface AttemptResult {
  content: string
  toolCalls: ToolCall[]
  usage?: TokenUsage
  /** 停止原因（stop / tool_calls / length / content_filter / …）。
   *  length = 单轮输出达到 max_tokens 上限被截断（"无声停止"的关键信号，见 runner.ts） */
  finishReason?: string
  /** 用户主动中止（按部分内容正常完成处理，保持旧行为） */
  aborted?: boolean
}

/**
 * 发起流式补全请求
 * 返回 { content, toolCalls }
 * 网络失败（5xx / 超时 / 连接重置等）在尚未向 UI 输出任何 token 前自动重试；
 * 重试次数读取设置 maxRetries（-1 = 无限），退避 1s→2s→4s… 上限 30s。
 */
export async function streamChat(
  provider: ProviderConfig,
  params: CompletionParams,
  cb?: StreamCallbacks
): Promise<{ content: string; toolCalls: ToolCall[]; usage?: TokenUsage; finishReason?: string }> {
  const model = params.model || provider.defaultModel
  const body: Record<string, unknown> = {
    model,
    messages: params.messages.map(m => {
      const msg: Record<string, unknown> = {
        role: m.role,
        // content 可能是 string、null 或多模态 ContentPart[]（截图工具结果）
        content: Array.isArray(m.content) ? m.content : (m.content ?? '')
      }
      // 只包含有值的字段，避免 llama.cpp 等严格后端因 null 报错
      if (m.tool_calls && m.tool_calls.length > 0) msg.tool_calls = m.tool_calls
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
      if (m.name) msg.name = m.name
      return msg
    }),
    stream: true,
    stream_options: { include_usage: true }
  }
  if (params.tools?.length) {
    body.tools = params.tools
    body.tool_choice = 'auto'
  }
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.maxTokens) body.max_tokens = params.maxTokens
  // reasoning_effort（DeepSeek-R1 / OpenAI o-series 等）
  if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort

  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`
  const maxRetries = getMaxRetries()
  // 一旦向回调发出第一个 token / tool call 即置 true（之后不再重试，避免重复输出）
  const state = { emitted: false }

  try {
    const result = await withRetry(
      () => attemptStreamChat(url, body, provider, params, cb, state),
      {
        maxRetries,
        label: `LLM ${provider.name || provider.baseUrl}`,
        // 仅在尚未向 UI 输出任何内容时才重试（否则聊天区会收到重复内容）
        shouldRetry: (err) => !state.emitted && isRetriableError(err),
        onRetry: (failedAttempt, max, error) => cb?.onRetry?.(failedAttempt, max, error)
      }
    )
    cb?.onComplete?.(result.content, result.toolCalls)
    return { content: result.content, toolCalls: result.toolCalls, usage: result.usage, finishReason: result.finishReason }
  } catch (err) {
    cb?.onError?.(err as Error)
    throw err
  }
}

/**
 * 单次流式尝试（不含重试逻辑，重试由外层 streamChat 处理）
 * 中止处理：
 * - 用户中止（params.signal）→ 按部分内容正常完成返回（不重试）
 * - 流空闲超时（120s 无数据）→ 抛出可重试错误
 */
async function attemptStreamChat(
  url: string,
  body: Record<string, unknown>,
  provider: ProviderConfig,
  params: CompletionParams,
  cb: StreamCallbacks | undefined,
  state: { emitted: boolean }
): Promise<AttemptResult> {
  const acc = createStreamAccumulator()

  // 用户中止信号 + 流空闲超时 合并为一个 AbortController
  const ctrl = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => ctrl.abort(), STREAM_IDLE_TIMEOUT_MS)
  }
  const onUserAbort = () => ctrl.abort()
  if (params.signal) {
    if (params.signal.aborted) ctrl.abort()
    else params.signal.addEventListener('abort', onUserAbort, { once: true })
  }
  resetIdleTimer()

  try {
    const resp = await getFetch()(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })

    if (!resp.ok) {
      const errText = await resp.text()
      throw new HttpError(resp.status, `LLM API ${resp.status}: ${errText.slice(0, 500)}`)
    }

    const reader = resp.body?.getReader()
    if (!reader) throw new Error('No response body')
    const decoder = new TextDecoder()
    const sse = new SseLineBuffer()
    // 每收到一条完整 SSE 行：解析 data 载荷 → 更新聚合状态 → 推送流式回调
    const handleLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const applied = applySseData(acc, trimmed.slice(5).trim())
      if (applied.emitted) state.emitted = true
      if (applied.token) cb?.onToken?.(applied.token)
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      resetIdleTimer()
      sse.feed(decoder.decode(value, { stream: true }), handleLine)
    }
    // 流结束：flush 剩余缓冲（末块常不带换行，且携带 finish_reason / usage）
    sse.flush(handleLine)

    return accumulateResult(acc)
  } catch (err) {
    if (ctrl.signal.aborted) {
      if (params.signal?.aborted) {
        // 用户中止 → 部分内容按正常完成返回（不重试）
        return { ...accumulateResult(acc), aborted: true }
      }
      // 流空闲超时 → 抛出可重试错误（message 匹配重试规则）
      throw new Error(`LLM stream idle timeout: no data received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`)
    }
    throw err
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    if (params.signal) params.signal.removeEventListener('abort', onUserAbort)
  }
}

/**
 * 非流式补全（简短调用，如生成会话标题）
 * 网络失败自动重试（与 streamChat 同一策略）
 */
export async function complete(
  provider: ProviderConfig,
  messages: ChatMessage[],
  model?: string,
  maxTokens = 200
): Promise<string> {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`
  return withRetry(
    async () => {
      const resp = await getFetch()(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: model || provider.defaultModel,
          messages: messages.map(m => {
            const msg: Record<string, unknown> = {
              role: m.role,
              content: Array.isArray(m.content) ? m.content : (m.content ?? '')
            }
            if (m.tool_calls && m.tool_calls.length > 0) msg.tool_calls = m.tool_calls
            if (m.tool_call_id) msg.tool_call_id = m.tool_call_id
            if (m.name) msg.name = m.name
            return msg
          }),
          max_tokens: maxTokens,
          temperature: 0.3,
          stream: false
        })
      })
      if (!resp.ok) throw new HttpError(resp.status, `LLM API ${resp.status}: ${await resp.text()}`)
      const json: any = await resp.json()
      return json.choices?.[0]?.message?.content || ''
    },
    { maxRetries: getMaxRetries(), label: `LLM complete ${provider.name || provider.baseUrl}` }
  )
}
