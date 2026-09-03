// ============================================================
// 重试工具 — 网络不稳定时远端请求（LLM / MCP）自动重试
// - maxRetries: 首次失败后的重试次数；-1 = 无限重试，0 = 不重试，默认 5（设置可配）
// - 指数退避: 1s → 2s → 4s … 上限 30s（±20% 抖动）
// ============================================================
import { getSettings } from '../store/db'
import { log } from '../llm/logger'

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
 * 判断错误是否值得重试：
 * - 用户主动中止（AbortError）→ 永不重试
 * - HttpError → 仅瞬时状态码
 * - 网络层错误（fetch failed / 连接重置 / 超时 / DNS 瞬断）→ 重试
 * - 4xx 业务错误（400/401/403/404）→ 重试无意义，不重试
 */
export function isRetriableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as Error & { status?: number; cause?: { code?: string } }
  if (e.name === 'AbortError') return false
  if (typeof e.status === 'number') return RETRYABLE_STATUS.has(e.status)
  const code = e.cause?.code
  if (code && RETRYABLE_CODES.has(code)) return true
  return /fetch failed|network|socket|timed? ?out/i.test(e.message || '')
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
 * maxRetries = -1 时无限重试（间隔封顶 MAX_DELAY_MS）
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
      if (!shouldRetry(error) || (!unlimited && attempt > opts.maxRetries)) throw error
      const delay = backoffDelay(attempt)
      log('warn', `[Retry] ${opts.label} 第 ${attempt}${unlimited ? '' : `/${opts.maxRetries}`} 次失败: ${String(error?.message || err).slice(0, 200)} — ${(delay / 1000).toFixed(1)}s 后重试`)
      try {
        opts.onRetry?.(attempt, opts.maxRetries, error)
      } catch { /* 回调异常忽略 */ }
      await sleep(delay)
      attempt++
    }
  }
}

/**
 * 从设置读取最大重试次数
 * -1 = 无限，0 = 不重试，默认 5（兼容旧设置无此字段）；钳制到 -1…99
 */
export function getMaxRetries(): number {
  const r: unknown = getSettings().maxRetries
  if (typeof r !== 'number' || !Number.isFinite(r)) return DEFAULT_MAX_RETRIES
  const v = Math.round(r)
  if (v < 0) return UNLIMITED_RETRIES
  return Math.min(v, 99)
}
