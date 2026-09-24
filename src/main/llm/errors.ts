/**
 * llama.cpp returns HTTP 500 for malformed client-supplied historical tool
 * arguments. This is a deterministic request error, not a transient server
 * failure, so retrying the identical payload can never recover.
 */
export function isMalformedToolArgumentsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message || ''
  return /failed to parse tool call arguments as json|func_args_not_string|invalid tool call arguments/i.test(message)
}

/**
 * 端点拒绝思考强度参数：严格校验请求体的网关 / 旧版后端会对未知字段
 * 直接 400/422 并点名该字段（`reasoning_effort`、`enable_thinking` 等；
 * 见 `llm/reasoning.ts` 的方言编码）。这类失败是确定性的，重发同一载荷
 * 永远无法恢复，需要的是"去掉这些参数再试一次"（见 provider.ts）。
 *
 * 只认错误文本里点名该字段的情况：其它 400/422（上下文超限、历史 tool 序列
 * 非法、参数取值越界）都不得被误判为可降级参数。
 */
export function isReasoningParamRejected(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const status = (error as Error & { status?: number }).status
  if (status !== 400 && status !== 422) return false
  return /reasoning[._ ]?effort|enable_thinking|thinking_budget/i.test(error.message || '')
}
