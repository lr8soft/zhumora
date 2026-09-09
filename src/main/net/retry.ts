// ============================================================
// 重试工具 — 网络不稳定时远端请求（LLM / MCP）自动重试
// - maxRetries: 首次失败后的重试次数；-1 = 无限重试，0 = 不重试，默认 5（设置可配）
// - 指数退避: 1s → 2s → 4s … 上限 30s（±20% 抖动）
//
// 纯函数部分（错误分类 / 重试循环）在 retryCore.ts（零依赖，可 node 单测）；
// 本文件把它接到进程日志上，并补充需要读设置的 getMaxRetries。
// 既有调用方（provider / mcp）继续从本文件导入，签名不变。
// ============================================================
import { getSettings } from '../store/db'
import { log } from '../llm/logger'
import {
  DEFAULT_MAX_RETRIES,
  UNLIMITED_RETRIES,
  HttpError,
  isRetriableError,
  isOfflineError,
  isStreamableNetworkError,
  isStreamIdleTimeoutError,
  withRetry as withRetryCore,
  type RetryOptions
} from './retryCore'

export {
  DEFAULT_MAX_RETRIES,
  UNLIMITED_RETRIES,
  HttpError,
  isRetriableError,
  isOfflineError,
  isStreamableNetworkError,
  isStreamIdleTimeoutError,
  type RetryOptions
}

/**
 * 带重试执行异步函数（日志接 llm/logger，转发到主进程日志流）
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  return withRetryCore(fn, { ...opts, onLog: (level, msg) => log(level, msg) })
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
