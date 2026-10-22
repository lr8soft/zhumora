// ============================================================
// LLM Provider 适配器 — 统一 OpenAI 兼容接口
// 天然支持任意端点：OpenAI / Anthropic(兼容层) / Ollama / vLLM
// ============================================================
import type { ChatMessage, ProviderConfig, ToolCall, ToolDefinition } from '../../shared/types'
import { hasValidToolCalls } from '../../shared/toolCalls'
import { createProviderRequestHeaders } from '../../shared/providerHeaders'
import { log } from './logger'
import { getFetch } from '../net/fetch'
import { getMaxRetries, isStreamableNetworkError, isStreamIdleTimeoutError, withRetry } from '../net/retry'
import {
  createStreamAccumulator, accumulateResult, type TokenUsage
} from './sseAccumulator'
import { readChatStream } from './streamResponse'
import { IncompleteStreamError, ProviderHttpError, ProviderStreamError } from './streamErrors'
import { isReasoningParamRejected } from './errors'
import { applyReasoningParams, type ReasoningEffortParam } from './reasoning'
import { withProviderRequest } from './requestRuntime'
import { shouldRetryProviderError } from './providerRetry'
import { serializeMessages, httpResponseError, canReplayReasoning, outputTokenLimit } from './responseParsing.ts'
import { requestTextCompletion } from './textCompletion.ts'
import type { GenerationMetadata } from '../../shared/generation.ts'

export type { TokenUsage }

export interface StreamCallbacks {
  onToken?: (token: string) => void
  /**
   * 模型思考内容增量（reasoning_content / reasoning 字段，
   * DeepSeek-R1、豆包、Kimi、OpenAI o-series 等推理模型在正文前流式输出）。
   * 不参与正文拼接；是否回传由 Provider/model 绑定的请求投影策略决定。
   */
  onReasoningToken?: (token: string) => void
  onComplete?: (fullText: string, toolCalls: ToolCall[]) => void
  onError?: (error: Error) => void
  /** 网络失败，正在自动重试（failedAttempt = 已失败次数，maxRetries = -1 表示无限） */
  onRetry?: (failedAttempt: number, maxRetries: number, error: Error) => void
  /** Preserve a failed visible attempt; only willRetry allows preparation of a continuation request. */
  onInterruptedAttempt?: (partial: StreamAttemptResult, error: Error, willRetry: boolean) => ChatMessage[] | Promise<ChatMessage[]>
}

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

export interface CompletionParams {
  maxRetries?: number
  requestTimeoutMs?: number
  progressTimeoutMs?: number
  terminalTimeoutMs?: number
  purpose?: GenerationMetadata['purpose']
  messages: ChatMessage[]
  model?: string
  tools?: ToolDefinition[]
  /** OpenAI-compatible tool selection mode. Defaults to auto when tools are present. */
  toolChoice?: ToolChoice
  temperature?: number
  maxTokens?: number
  /** 线上 `reasoning_effort` 取值。对话级档位到线上取值的映射在 runner 边界完成
   *  （见 llm/reasoning.ts）；undefined = 不发送该字段，保留端点默认行为。 */
  reasoningEffort?: ReasoningEffortParam
  signal?: AbortSignal
}

/** 流空闲超时：120s 无任何数据块则中止（防止半开连接永久挂起；未输出时该错误可重试） */
const STREAM_IDLE_TIMEOUT_MS = 120_000

/** 单次流式尝试的结果 */
export interface StreamAttemptResult {
  reasoning: string
  refusal?: string
  generation?: GenerationMetadata
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
 * 返回 { content, toolCalls, streamInterrupted? }
 * 网络失败（5xx / 超时 / 连接重置等）在尚未向 UI 输出任何 token 前自动重试；
 * 重试次数读取设置 maxRetries（-1 = 无限），退避 1s→2s→4s… 上限 30s。
 *
 * 流"中途"断开（已输出部分内容后网络错误）：
 * - 未输出过 → 透明重试（同上）；
 * - 已输出过 → 不重发（UI 会重复），不抛错 —— 按部分内容正常返回并置
 *   streamInterrupted，由 agent 循环走续写恢复（对齐截断恢复通路），
 *   离线类错误（明确无网络）则仍抛错让 run 收尾。
 * EOF/DONE 缺失 finish_reason 即使没有输出也按 streamInterrupted 返回，
 * 交给 runner 有界恢复；协议错误则明确失败，不走无限网络重试。
 */
export async function streamChat(
  provider: ProviderConfig,
  params: CompletionParams,
  cb?: StreamCallbacks
): Promise<StreamAttemptResult & { streamInterrupted?: boolean }> {
  const invalidHistoryIndex = params.messages.findIndex(message => !hasValidToolCalls(message))
  if (invalidHistoryIndex >= 0) {
    const error = new Error(`LLM request blocked: message ${invalidHistoryIndex} contains malformed tool call arguments`)
    cb?.onError?.(error)
    throw error
  }
  const model = params.model || provider.defaultModel
  const body: Record<string, unknown> = {
    model,
    messages: serializeMessages(params.messages, provider, model, !!params.tools?.length),
    stream: true,
    stream_options: { include_usage: true }
  }
  if (params.tools?.length) {
    body.tools = params.tools
    body.tool_choice = params.toolChoice ?? 'auto'
  }
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.maxTokens) Object.assign(body, outputTokenLimit(provider, params.maxTokens))
  // 思考强度（llama.cpp / vLLM / SGLang / LiteLLM 用标准 reasoning_effort；
  // DeepSeek / 百炼官方 API 的字段差异在 llm/reasoning.ts 内编码）。
  // 'none' 是显式关闭思考，与"不发送该字段"语义不同。
  const reasoningFields = applyReasoningParams(body, provider, params.reasoningEffort, model)
  let reasoningDowngraded = false

  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`
  const maxRetries = params.maxRetries ?? getMaxRetries()
  const state: { emitted: boolean; partial: StreamAttemptResult | null } = { emitted: false, partial: null }

  try {
    // 端点不认识思考强度参数（严格校验请求体的网关 / 旧版后端直接 400/422）
    // 时去掉本次实际写入的字段重发一次，而不是让整轮运行失败。删掉后 body 里
    // 不再有这些字段，外层网络重试自然沿用降级后的载荷（无需额外标志位）；
    // 仅在尚未输出内容时降级。
    const attempt = async (): Promise<StreamAttemptResult> => {
      try {
        return await attemptStreamChat(url, body, provider, params, cb, state)
      } catch (err) {
        if (params.reasoningEffort === 'none'
          || reasoningDowngraded || state.emitted || reasoningFields.length === 0 || !isReasoningParamRejected(err)) throw err
        for (const field of reasoningFields) delete body[field]
        reasoningDowngraded = true
        log('warn', `Endpoint rejected ${reasoningFields.join('/')} — retrying once without it (${provider.name || provider.baseUrl})`)
        return attemptStreamChat(url, body, provider, params, cb, state)
      }
    }

    const result = await withRetry(
      attempt,
      {
        maxRetries,
        label: `LLM ${provider.name || provider.baseUrl}`,
        // 会话中止立即打断退避等待与后续重试（否则停止后 runner 会卡在
        // 最长 30s 的退避里无法 settle，会话永久 busy，见 retryCore 注释）
        signal: params.signal,
        // Visible provider failures continue from durable state; raw network truncation
        // keeps the runner's independent bounded recovery rather than becoming unlimited.
        shouldRetry: err => shouldRetryProviderError(err) && (!state.emitted
          || (err instanceof ProviderStreamError && !!state.partial && !!cb?.onInterruptedAttempt)),
        beforeRetry: error => settleInterruptedAttempt(error, true),
        onRetry: cb?.onRetry
      }
    )
    cb?.onComplete?.(result.content, result.toolCalls)
    return result
  } catch (err) {
    // 流中途断开（已输出部分内容后网络错误）：重发会让 UI 收到重复内容，
    // 透明重试不可行 → 不抛错，把部分输出标记为"流中断轮"交给 agent 循环，
    // 走与截断恢复同构的续写通路（保留部分文本 + 注入续写指令）。
    // 流空闲超时（模型侧长时间无数据）同理。
    // 离线类错误（明确无网络）重连无意义，仍抛错让 run 收尾告知用户。
    if (err instanceof IncompleteStreamError
      || (!(err instanceof ProviderStreamError) && state.emitted && (isStreamableNetworkError(err) || isStreamIdleTimeoutError(err)))) {
      const error = err as Error
      log('warn', `LLM stream incomplete (${String(error?.message || err).slice(0, 120)}) — returning partial content for agent-level continuation`)
      if (state.partial) {
        cb?.onComplete?.(state.partial.content, state.partial.toolCalls)
        return { ...state.partial, streamInterrupted: true }
      }
    }
    await settleInterruptedAttempt(err as Error, false)
    cb?.onError?.(err as Error)
    throw err
  }

  async function settleInterruptedAttempt(error: Error, willRetry: boolean): Promise<void> {
    const partial = state.emitted ? state.partial : null
    // Claim the attempt before calling persistence. If settlement fails, the outer
    // error path must neither persist it twice nor treat it as network truncation.
    state.emitted = false
    state.partial = null
    if (partial && cb?.onInterruptedAttempt) {
      const messages = await cb.onInterruptedAttempt(partial, error, willRetry)
      if (willRetry) body.messages = serializeMessages(messages, provider, model, !!params.tools?.length)
    }
  }
}

/**
 * 单次流式尝试（不含重试逻辑，重试由外层 streamChat 处理）
 * 中止处理：
 * - 用户中止（params.signal）→ 按部分内容正常完成返回（不重试）
 * - 流空闲超时（120s 无数据）→ 抛出可重试错误
 * 失败时把已聚合的部分内容写入 state.partial（供 streamChat 的
 * "流中断续写"兜底读取）；用户中止路径不写（该部分按正常完成返回）。
 */
async function attemptStreamChat(
  url: string, body: Record<string, unknown>, provider: ProviderConfig, params: CompletionParams,
  cb: StreamCallbacks | undefined, state: { emitted: boolean; partial: StreamAttemptResult | null }
): Promise<StreamAttemptResult> {
  return withProviderRequest(provider, params.signal, () => executeStreamChat(url, body, provider, params, cb, state))
}

async function executeStreamChat(
  url: string,
  body: Record<string, unknown>,
  provider: ProviderConfig,
  params: CompletionParams,
  cb: StreamCallbacks | undefined,
  state: { emitted: boolean; partial: StreamAttemptResult | null }
): Promise<StreamAttemptResult> {
  const acc = createStreamAccumulator()
  let reasoning = ''

  // 用户中止信号 + 流空闲超时 合并为一个 AbortController
  const ctrl = new AbortController()
  let timeoutReason: 'request_timeout' | 'idle_timeout' | undefined
  const deadline = params.requestTimeoutMs ? setTimeout(() => {
    timeoutReason = 'request_timeout'; ctrl.abort()
  }, params.requestTimeoutMs) : null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { timeoutReason = 'idle_timeout'; ctrl.abort() }, STREAM_IDLE_TIMEOUT_MS)
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
      headers: createProviderRequestHeaders(provider),
      body: JSON.stringify(body),
      signal: ctrl.signal
    })

    if (!resp.ok) {
      throw await httpResponseError(resp, { provider: provider.name || provider.id, model: params.model || provider.defaultModel })
    }

    await readChatStream(resp, acc, applied => {
      if (applied.emitted) state.emitted = true
      if (applied.reasoning) { reasoning += applied.reasoning; cb?.onReasoningToken?.(applied.reasoning) }
      if (applied.token) cb?.onToken?.(applied.token)
    }, resetIdleTimer, {
      provider: provider.name || provider.id, model: params.model || provider.defaultModel
    }, { progressTimeoutMs: params.progressTimeoutMs, terminalTimeoutMs: params.terminalTimeoutMs,
      captureFrames: provider.captureResponses, signal: ctrl.signal })

    if (acc.finishReason === 'insufficient_system_resource') {
      throw new ProviderStreamError('provider', { type: 'overloaded_error',
        message: 'Provider interrupted generation: insufficient_system_resource', finish_reason: acc.finishReason })
    }
    return snapshot()
  } catch (err) {
    if (ctrl.signal.aborted) acc.generation = { version: 1, ...acc.generation, status: 'incomplete',
      termination: params.signal?.aborted ? 'aborted' : 'timeout', reason: params.signal?.aborted ? 'aborted' : timeoutReason }
    if (err instanceof ProviderStreamError || err instanceof ProviderHttpError) {
      acc.generation = { version: 1, ...acc.generation, status: 'incomplete', providerError: err.diagnostics,
        ...(err.diagnostics.requestId ? { requestId: err.diagnostics.requestId } : {}) }
      err.generation = snapshot().generation
    }
    // 缺失结束信号即使完全空白也交给 Agent 恢复；其他异常仅保留已推流的内容。
    if (state.emitted || err instanceof IncompleteStreamError) state.partial = snapshot()
    if (ctrl.signal.aborted) {
      if (params.signal?.aborted) {
        // 用户中止 → 部分内容按正常完成返回（不重试）
        return { ...snapshot(), aborted: true }
      }
      // 流空闲超时 → 抛出可重试错误（message 匹配重试规则）
      if (timeoutReason === 'request_timeout') throw new Error(`LLM request timeout after ${params.requestTimeoutMs! / 1000}s`)
      throw new Error(`LLM stream idle timeout: no data received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`)
    }
    throw err
  } finally {
    if (deadline) clearTimeout(deadline)
    if (idleTimer) clearTimeout(idleTimer)
    if (params.signal) params.signal.removeEventListener('abort', onUserAbort)
    log('info', 'LLM response: ' + JSON.stringify(snapshot().generation))
  }
  function snapshot(): StreamAttemptResult {
    const result = accumulateResult(acc)
    return { ...result, reasoning, generation: { version: 1, ...result.generation, status: result.refusal
      || result.finishReason === 'content_filter' || result.finishReason === 'refusal' ? 'refused'
      : result.generation?.status === 'incomplete' || !['stop', 'tool_calls'].includes(result.finishReason ?? '') ? 'incomplete' : 'complete',
      providerId: provider.id, model: params.model || provider.defaultModel,
      reasoningReplay: canReplayReasoning({ role: 'assistant', content: '', reasoning: 'present',
        reasoningSource: { providerId: provider.id, model: params.model || provider.defaultModel } },
        provider, params.model || provider.defaultModel, !!params.tools?.length),
      purpose: params.purpose ?? 'agent' } }
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
  maxTokens = 200,
  signal?: AbortSignal
): Promise<string> {
  return requestTextCompletion(provider, messages, model, maxTokens, signal)
}
