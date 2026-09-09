// ============================================================
// 重试核心 — 纯函数，无副作用，可直接用 node 运行单元测试
// （tests/retryPolicy.test.ts）。
//
// 拆分自 retry.ts：retry.ts 顶部依赖 store/db（读设置）进而依赖
// electron，无法在纯 node 环境加载。这里放不碰任何进程状态的部分，
// retry.ts 再导出这些符号以保持既有调用方（provider / mcp）不变。
// ============================================================

/** 默认最大重试次数 */
export const DEFAULT_MAX_RETRIES = 5
/** 无限重试哨兵值 */
export const UNLIMITED_RETRIES = -1

/** HTTP 错误（携带状态码，供重试判定使用） */
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** 值得重试的瞬时 HTTP 状态码（5xx / 429 限流 / 408 超时 / Cloudflare 5xx） */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529])

/** 值得重试的网络层错误码（node fetch / undici） */
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'
])

/**
 * 值得重试的 Chromium 网络错误码（Electron net.fetch；错误 message 形如
 * "net::ERR_INCOMPLETE_CHUNKED_ENCODING"，undici 的 cause 里不会出现 ERR_*）。
 * 覆盖：流中途断开（chunked 编码未完成 / HTTP2 协议错误 / 连接重置 / 对端关闭）、
 * 代理与 DNS 抖动、超时、TLS 握手失败。
 * 排除：ERR_ABORTED（含用户中止，永不重试）、ERR_FAILED（Chromium 通用兜底码，
 * 与 ERR_INVALID_URL 等确定性错误无法区分，重试无意义且会掩盖真实问题）、
 * ERR_INTERNET_DISCONNECTED / ERR_ADDRESS_UNREACHABLE（由 withRetry 的
 * 离线保护整体拦截，不逐个列入）。
 */
const RETRYABLE_NET_CODES = new Set([
  'ERR_HTTP2_PROTOCOL_ERROR', 'ERR_INCOMPLETE_CHUNKED_ENCODING', 'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED', 'ERR_EMPTY_RESPONSE', 'ERR_NETWORK_CHANGED',
  'ERR_NAME_NOT_RESOLVED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_PROXY_CONNECTION_FAILED',
  'ERR_PROXY_CERTIFICATE_INVALID', 'ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT',
  'ERR_SSL_PROTOCOL_ERROR'
])

/**
 * 判断错误是否值得重试：
 * - 用户主动中止（AbortError）→ 永不重试
 * - HttpError → 仅瞬时状态码
 * - 网络层错误（fetch failed / 连接重置 / 超时 / DNS 瞬断）→ 重试
 * - Chromium 网络错误（net.fetch 的 net::ERR_*）→ 仅瞬时类（RETRYABLE_NET_CODES）
 * - 4xx 业务错误（400/401/403/404）→ 重试无意义，不重试
 */
export function isRetriableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as Error & { status?: number; cause?: { code?: string } }
  if (e.name === 'AbortError') return false
  if (typeof e.status === 'number') return RETRYABLE_STATUS.has(e.status)
  const message = e.message || ''
  // Electron net.fetch（Chromium 网络栈）：错误串为 "net::ERR_XXX"，
  // 与 undici 错误码体系不同，必须单独识别（否则流中断被误判为不可重试）
  const netCode = /^net::(ERR_[A-Z0-9_]+)/.exec(message)?.[1]
  if (netCode) return RETRYABLE_NET_CODES.has(netCode)
  const code = e.cause?.code
  if (code && RETRYABLE_CODES.has(code)) return true
  return /fetch failed|network|socket|timed? ?out/i.test(message)
}

/**
 * 机器/网络整体离线（明确信号）：重试只会耗尽退避预算，直接快速失败。
 * 只认 Chromium 的显式无网络错误（net.fetch 场景）—— undici 的 EAI_AGAIN
 * 是歧义的（可能是 DNS 瞬时抖动而非真离线），仍按可重试处理。
 */
export function isOfflineError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  return /^net::(ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE)$/.test((err as Error).message || '')
}

/**
 * 流式传输可恢复的网络错误 —— 用于 SSE 流"中途断开"的判定
 * （连接在传输数据途中被网络中断，且值得让 agent 循环续接，
 *  而不是直接把整个对话轮判死）。
 *
 * 与 isRetriableError 的区别：这里排除"离线类"错误。Wi-Fi 断开时
 * 重连同一端点没有意义（重试会持续失败并耗尽退避预算），
 * 应直接让 runner 走收尾路径告知用户。
 */
export function isStreamableNetworkError(err: unknown): boolean {
  return isRetriableError(err) && !isOfflineError(err)
}

/**
 * 流空闲超时错误（provider 层抛出："LLM stream idle timeout: ..."）。
 * 连接没断，但模型侧长时间（120s）不发任何数据 —— 多为后端挂起。
 * 未输出时可重试（重新发起请求）；已输出部分时按"不完整本轮"交 agent 循环续接。
 */
export function isStreamIdleTimeoutError(err: unknown): boolean {
  return err instanceof Error && /^LLM stream idle timeout:/i.test(err.message || '')
}

export interface RetryOptions {
  /** 最大重试次数（首次尝试失败后的重试）。-1 = 无限，0 = 不重试 */
  maxRetries: number
  /** 日志标签，如 'LLM xxx'、'MCP connect "xxx"' */
  label: string
  /** 自定义重试判定（默认 isRetriableError） */
  shouldRetry?: (err: unknown) => boolean
  /** 每次重试前回调（供 UI 提示），failedAttempt = 已失败次数 */
  onRetry?: (failedAttempt: number, maxRetries: number, error: Error) => void
  /** 日志函数（默认静默；调用方注入 log 以保持本模块零依赖） */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30000

/** 指数退避 + 随机抖动 */
function backoffDelay(failedAttempt: number): number {
  const base = Math.min(BASE_DELAY_MS * 2 ** (failedAttempt - 1), MAX_DELAY_MS)
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 带重试执行异步函数
 * maxRetries = -1 时无限重试（间隔封顶 MAX_DELAY_MS）。
 * 整体离线（明确无网络，isOfflineError）时首次失败即抛出不重试 ——
 * 无网络时重试只会把退避预算耗尽，且 UI 会误显示"重试中"。
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const shouldRetry = opts.shouldRetry || isRetriableError
  const unlimited = opts.maxRetries === UNLIMITED_RETRIES
  let attempt = 1
  for (;;) {
    try {
      return await fn(attempt)
    } catch (err) {
      const error = err as Error
      if (!shouldRetry(error) || isOfflineError(error) || (!unlimited && attempt > opts.maxRetries)) throw error
      const delay = backoffDelay(attempt)
      opts.onLog?.('warn', `[Retry] ${opts.label} 第 ${attempt}${unlimited ? '' : `/${opts.maxRetries}`} 次失败: ${String(error?.message || err).slice(0, 200)} — ${(delay / 1000).toFixed(1)}s 后重试`)
      try {
        opts.onRetry?.(attempt, opts.maxRetries, error)
      } catch { /* 回调异常忽略 */ }
      await sleep(delay)
      attempt++
    }
  }
}
