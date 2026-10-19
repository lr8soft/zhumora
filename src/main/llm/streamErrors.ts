import { formatProviderStreamError, type StreamErrorContext } from './providerErrorDetails.ts'

/** A clean HTTP EOF/DONE without the selected choice's finish_reason is still incomplete. */
export class IncompleteStreamError extends Error {
  constructor() {
    super('LLM stream ended before finish_reason')
    this.name = 'IncompleteStreamError'
  }
}

/** Provider failures must include their original details, not just a generic stop notification. */
export class ProviderStreamError extends Error {
  readonly status?: number
  constructor(detail: 'payload' | 'provider' | 'content_type', error?: unknown, context?: StreamErrorContext) {
    super(detail === 'provider' ? formatProviderStreamError(error, context)
      : detail === 'content_type' ? 'LLM provider returned a non-SSE response to a streaming request'
        : 'LLM provider returned an invalid chat completion stream payload')
    this.name = 'ProviderStreamError'
    if (detail === 'provider' && error && typeof error === 'object') {
      const fields = error as Record<string, unknown>
      const status = [fields.status, fields.status_code, fields.code]
        .map(value => typeof value === 'number' ? value : typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : undefined)
        .find(value => value !== undefined && Number.isInteger(value) && value >= 100 && value <= 599)
      this.status = status ?? (fields.type === 'rate_limit_error' || fields.code === 'rate_limit_exceeded' ? 429 : undefined)
    }
  }
}
