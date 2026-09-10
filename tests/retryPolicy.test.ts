// ============================================================
// retryCore 单元测试 — 直接 node 运行（零依赖纯模块）
//   node tests/retryPolicy.test.ts
//
// 覆盖"LLM 流中途网络断开无重试"修复的核心判定：
//   - Chromium 网络错误（Electron net.fetch，message 形如
//     "net::ERR_HTTP2_PROTOCOL_ERROR"）被正确识别为可重试；
//   - 离线类错误（明确无网络）快速失败，不耗尽重试预算；
//   - 流空闲超时被识别（已输出部分时走 agent 循环续接）。
// ============================================================
import assert from 'node:assert/strict'
import {
  HttpError,
  isRetriableError,
  isOfflineError,
  isStreamableNetworkError,
  isStreamIdleTimeoutError,
  withRetry,
  UNLIMITED_RETRIES
} from '../src/main/net/retryCore.ts'
import { isMalformedToolArgumentsError } from '../src/main/llm/errors.ts'

// ---- Chromium 网络错误（net.fetch）----
// 截图里的两种真实错误：必须可重试（此前两者都不匹配 → 直接判死）
assert.equal(isRetriableError(new Error('net::ERR_HTTP2_PROTOCOL_ERROR')), true, 'ERR_HTTP2_PROTOCOL_ERROR 可重试')
assert.equal(isRetriableError(new Error('net::ERR_INCOMPLETE_CHUNKED_ENCODING')), true, 'ERR_INCOMPLETE_CHUNKED_ENCODING 可重试')
assert.equal(isRetriableError(new Error('net::ERR_CONNECTION_RESET')), true, 'ERR_CONNECTION_RESET 可重试')
assert.equal(isRetriableError(new Error('net::ERR_EMPTY_RESPONSE')), true, 'ERR_EMPTY_RESPONSE 可重试')
assert.equal(isRetriableError(new Error('net::ERR_TIMED_OUT')), true, 'ERR_TIMED_OUT 可重试')

// 确定性/用户主动错误：绝不重试
assert.equal(isRetriableError(new Error('net::ERR_ABORTED')), false, 'ERR_ABORTED（含用户中止）不重试')
assert.equal(isRetriableError(new Error('net::ERR_FAILED')), false, 'ERR_FAILED（兜底码）不重试')
assert.equal(isRetriableError(new Error('net::ERR_INVALID_URL')), false, 'ERR_INVALID_URL 不重试')

// ---- undici 错误（node fetch）行为保持不变 ----
assert.equal(isRetriableError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })), true, 'ECONNRESET 可重试')
assert.equal(isRetriableError(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } })), true, 'ETIMEDOUT 可重试')
assert.equal(isRetriableError(new Error('fetch failed')), true, 'fetch failed 文本匹配可重试')

// ---- AbortError / HTTP 状态码 ----
const abortErr = new Error('aborted')
abortErr.name = 'AbortError'
assert.equal(isRetriableError(abortErr), false, 'AbortError 永不重试')
assert.equal(isRetriableError(new HttpError(503, 'LLM API 503: x')), true, '503 可重试')
assert.equal(isRetriableError(new HttpError(429, 'LLM API 429: x')), true, '429 可重试')
assert.equal(isRetriableError(new HttpError(400, 'LLM API 400: bad request')), false, '400 不重试')
assert.equal(isRetriableError(new HttpError(401, 'LLM API 401: unauthorized')), false, '401 不重试')

// llama.cpp 会把历史中的残缺 function.arguments 报成 500，但同一 payload
// 重试永远不会恢复，provider 必须把它从普通 5xx 重试策略中排除。
const malformedArgs500 = new HttpError(500, 'Failed to parse tool call arguments as JSON: missing closing quote')
assert.equal(isRetriableError(malformedArgs500), true, '普通策略仍把 500 视为瞬时错误')
assert.equal(isMalformedToolArgumentsError(malformedArgs500), true, '识别 llama.cpp 的确定性工具参数错误')
assert.equal(isMalformedToolArgumentsError(new HttpError(500, 'internal server error')), false, '普通 500 不误判')

{
  let attempts = 0
  await assert.rejects(
    withRetry(async () => {
      attempts++
      throw malformedArgs500
    }, {
      maxRetries: UNLIMITED_RETRIES,
      label: 'llama malformed history',
      shouldRetry: error => !isMalformedToolArgumentsError(error) && isRetriableError(error)
    }),
    malformedArgs500
  )
  assert.equal(attempts, 1, '即使配置无限重试，确定性 malformed-history 500 也只请求一次')
}

// ---- 离线快速失败 ----
assert.equal(isOfflineError(new Error('net::ERR_INTERNET_DISCONNECTED')), true, 'Wi-Fi 断开识别为离线')
assert.equal(isOfflineError(new Error('net::ERR_ADDRESS_UNREACHABLE')), true, '地址不可达识别为离线')
assert.equal(isOfflineError(new Error('net::ERR_CONNECTION_RESET')), false, '连接重置不是离线')
assert.equal(isOfflineError(Object.assign(new Error('fetch failed'), { cause: { code: 'EAI_AGAIN' } })), false, 'undici EAI_AGAIN 是歧义信号，不判离线（仍可重试）')

// 离线 = 可重试判定之外再排除
assert.equal(isStreamableNetworkError(new Error('net::ERR_HTTP2_PROTOCOL_ERROR')), true, '流中断类错误可续接')
assert.equal(isStreamableNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED')), false, '离线不可续接（重连无意义）')
assert.equal(isStreamableNetworkError(new Error('net::ERR_FAILED')), false, '不可重试错误也不可续接')

// ---- 流空闲超时 ----
assert.equal(isStreamIdleTimeoutError(new Error('LLM stream idle timeout: no data received for 120s')), true, '空闲超时识别')
assert.equal(isStreamIdleTimeoutError(new Error('net::ERR_TIMED_OUT')), false, '普通超时不是空闲超时')

// ---- withRetry 行为 ----
// 1) 瞬时错误重试后成功（退避约 1s）
{
  let attempts = 0
  const result = await withRetry(async () => {
    attempts++
    if (attempts < 3) throw new Error('net::ERR_CONNECTION_RESET')
    return 'ok'
  }, { maxRetries: 5, label: 'test' })
  assert.equal(result, 'ok', '重试后成功')
  assert.equal(attempts, 3, '共 3 次尝试')
}

// 2) 离线错误首次失败即抛出（不重试、不退避）
{
  let attempts = 0
  let threw = false
  try {
    await withRetry(async () => {
      attempts++
      throw new Error('net::ERR_INTERNET_DISCONNECTED')
    }, { maxRetries: UNLIMITED_RETRIES, label: 'test' })
  } catch { threw = true }
  assert.equal(threw, true, '离线错误抛出')
  assert.equal(attempts, 1, '离线不重试（无限预算也只尝试 1 次）')
}

// 3) 不可重试错误首次失败即抛出
{
  let attempts = 0
  let threw = false
  try {
    await withRetry(async () => {
      attempts++
      throw new Error('net::ERR_FAILED')
    }, { maxRetries: 5, label: 'test' })
  } catch { threw = true }
  assert.equal(threw, true, '不可重试错误抛出')
  assert.equal(attempts, 1, '不可重试不重试')
}

// 4) 重试次数耗尽后抛出
{
  let attempts = 0
  let threw = false
  try {
    await withRetry(async () => {
      attempts++
      throw new Error('net::ERR_HTTP2_PROTOCOL_ERROR')
    }, { maxRetries: 2, label: 'test' })
  } catch { threw = true }
  assert.equal(threw, true, '耗尽后抛出')
  assert.equal(attempts, 3, '1 次初始 + 2 次重试')
}

console.log('retry policy tests passed')
