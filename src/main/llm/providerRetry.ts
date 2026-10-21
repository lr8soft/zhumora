import { isRetriableError } from '../net/retryCore.ts'
import { isMalformedToolArgumentsError } from './errors.ts'
import { IncompleteStreamError, ProviderStreamError } from './streamErrors.ts'

/** Only rate limiting is classified as provider busy; validation failures stay terminal. */
export function isProviderBusyError(error: unknown): boolean {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
  return status === 429
}

export function shouldRetryProviderError(error: unknown): boolean {
  // Busy 是传输层结论：429 表示本次请求没有被处理，响应体里恰好引用上游诊断文本
  // （代理转发 malformed-arguments 报错等）时仍按繁忙重试。状态判定必须优先于
  // message 正则，否则同一个 429 会因为措辞不同落到"确定性错误"而不再重试。
  // llama.cpp 用 HTTP 500 报 malformed history，该路径不受影响（500 不是 429）。
  if (isProviderBusyError(error)) return true
  if (error instanceof IncompleteStreamError || isMalformedToolArgumentsError(error)) return false
  if (error instanceof ProviderStreamError) return error.status !== undefined && isRetriableError(error)
  return isRetriableError(error)
}
