import type { ProviderFailureDetails } from '../../shared/generation.ts'
import type { StreamErrorContext } from './providerErrorDetails.ts'
import { isMalformedToolArgumentsError } from './errors.ts'

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function statusCode(value: unknown): number | undefined {
  const code = typeof value === 'number' ? value : typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : 0
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : undefined
}

/** HTTP and embedded provider statuses are separate evidence, not interchangeable success signals. */
export function providerFailureDetails(error: unknown, context: StreamErrorContext = {}, protocol = false): ProviderFailureDetails {
  const inner = fields(error); const outer = fields(context.envelope)
  const providerStatus = [inner.status, inner.status_code, inner.code, outer.status, outer.status_code, outer.code]
    .map(statusCode).find(code => code !== undefined)
  const status = context.httpStatus && context.httpStatus >= 400 ? context.httpStatus : providerStatus
  const requestId = inner.request_id ?? inner.requestId ?? outer.request_id ?? outer.requestId ?? context.requestId
  let category = protocol ? 'protocol' : classify(status, inner, outer)
  // Only the current error explains a malformed request. Attached traces may quote
  // previous failures and must not override an otherwise recoverable provider error.
  const message = typeof error === 'string' ? error
    : [inner.message, inner.detail].filter(value => typeof value === 'string').join('\n')
  if (!protocol && category !== 'rate_limit' && isMalformedToolArgumentsError(message)) category = 'invalid_request'
  return { category,
    ...(context.httpStatus !== undefined ? { httpStatus: context.httpStatus } : {}),
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(requestId != null ? { requestId: String(requestId) } : {}),
    ...(context.responseBody !== undefined ? { responseBody: context.responseBody } : {}),
    ...((context.envelope ?? error) !== undefined ? { envelope: context.envelope ?? error } : {}),
    ...(context.cause instanceof Error ? { cause: { name: context.cause.name, message: context.cause.message } } : {}) }
}

function classify(status: number | undefined, inner: Record<string, unknown>, outer: Record<string, unknown>): ProviderFailureDetails['category'] {
  // A real 429 is always retried according to the user setting, even if its body quotes another failure.
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'authentication'
  if (status === 402) return 'quota'
  const codes = [inner.type, inner.code, outer.type, outer.code].filter(value => typeof value === 'string')
    .map(value => value.toLowerCase())
  if (codes.some(code => ['authentication_error', 'permission_error', 'permission_denied', 'invalid_api_key', 'api_key_invalid'].includes(code))) return 'authentication'
  if (codes.some(code => ['insufficient_quota', 'quota_exceeded', 'billing_error', 'credit_balance_exhausted'].includes(code))) return 'quota'
  if (codes.some(code => ['content_filter', 'content_policy_violation', 'content_moderation', 'text_audit_answer_not_pass', 'refusal'].includes(code))) return 'policy'
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) return 'invalid_request'
  if (codes.some(code => ['invalid_request', 'invalid_request_error', 'invalid_prompt', 'model_not_found', 'validation_error'].includes(code))) return 'invalid_request'
  if (codes.some(code => code === 'rate_limit_error' || code === 'rate_limit_exceeded' || code === 'too_many_requests')) return 'rate_limit'
  if ((status !== undefined && (status >= 500 || status === 408))
    || codes.some(code => ['server_error', 'api_error', 'internal_error', 'overloaded_error', 'service_unavailable'].includes(code))) return 'server'
  return 'unknown'
}

export function providerFailureStatus(details: ProviderFailureDetails): number | undefined {
  if (details.httpStatus && details.httpStatus >= 400) return details.httpStatus
  const outer = fields(details.envelope)
  const error = fields(outer.error ?? outer)
  return details.providerStatus ?? (details.category === 'rate_limit' ? 429
    : error.type === 'overloaded_error' ? 529 : undefined)
}
