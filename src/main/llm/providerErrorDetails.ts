/** Identify the failed request without changing the provider's error details. */
export interface StreamErrorContext {
  provider?: string
  model?: string
  requestId?: unknown
  retryAfterMs?: number
  httpStatus?: number
  envelope?: unknown
  responseBody?: string
  cause?: unknown
}

/** Keep the entire error value: compatible gateways frequently put the actual cause in nested metadata. */
export function formatProviderStreamError(error: unknown, context: StreamErrorContext = {}): string {
  const fields: Record<string, unknown> = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown> : {}
  const message = typeof error === 'string' ? error : fields.message ?? fields.detail
  const envelope = context.envelope && typeof context.envelope === 'object'
    ? context.envelope as Record<string, unknown> : {}
  const lines = [`LLM provider stream error: ${message || 'Provider returned no error message.'}`]
  for (const [label, value] of [
    ['Provider', context.provider], ['Model', context.model],
    ['Request ID', fields.request_id ?? fields.requestId ?? envelope.request_id ?? envelope.requestId ?? context.requestId],
    ['HTTP status', context.httpStatus]
  ] as const) {
    if (value != null && value !== '') lines.push(`${label}: ${value}`)
  }
  if (error !== undefined && typeof error !== 'string') lines.push(`Details:\n${JSON.stringify(error, null, 2)}`)
  if (context.envelope !== undefined && context.envelope !== error) {
    lines.push(`Response envelope:\n${JSON.stringify(context.envelope, null, 2)}`)
  }
  return lines.join('\n')
}
