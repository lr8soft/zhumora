import { formatProviderStreamError, type StreamErrorContext } from './providerErrorDetails.ts'
import type { GenerationMetadata, ProviderFailureDetails } from '../../shared/generation.ts'
import { HttpError } from '../net/retryCore.ts'
import { providerFailureDetails, providerFailureStatus } from './providerFailure.ts'

/** A clean HTTP EOF/DONE without the selected choice's finish_reason is still incomplete. */
export class IncompleteStreamError extends Error {
  readonly reason: string
  constructor(reason = 'missing_finish') {
    super(reason === 'progress_timeout' ? 'LLM stream made no generation progress before its deadline'
      : reason === 'terminal_timeout' ? 'LLM tool stream did not close after its terminal choice'
        : 'LLM stream ended before finish_reason')
    this.name = 'IncompleteStreamError'
    this.reason = reason
  }
}

/** Provider failures must include their original details, not just a generic stop notification. */
export class ProviderStreamError extends Error {
  readonly status?: number
  readonly retryAfterMs?: number
  readonly diagnostics: ProviderFailureDetails
  generation?: GenerationMetadata
  constructor(detail: 'payload' | 'provider' | 'content_type', error?: unknown, context?: StreamErrorContext) {
    super(detail === 'provider' ? formatProviderStreamError(error, context)
      : detail === 'content_type' ? 'LLM provider returned a non-SSE response to a streaming request'
        : 'LLM provider returned an invalid chat completion stream payload'
          + (error === undefined ? '' : '\nDetails:\n' + JSON.stringify(error, null, 2)))
    this.name = 'ProviderStreamError'
    this.cause = context?.cause
    this.diagnostics = providerFailureDetails(error, context, detail !== 'provider')
    this.retryAfterMs = context?.retryAfterMs
    if (detail === 'provider') this.status = providerFailureStatus(this.diagnostics)
  }
}

/** Keep the existing HttpError contract while preserving the provider's complete response evidence. */
export class ProviderHttpError extends HttpError {
  readonly diagnostics: ProviderFailureDetails
  generation?: GenerationMetadata
  constructor(status: number, body: string, error: unknown, context: StreamErrorContext = {}) {
    super(status, `LLM API ${status}: ${body}\n${formatProviderStreamError(error, { ...context, httpStatus: status })}`,
      context.retryAfterMs)
    this.cause = context.cause
    this.diagnostics = providerFailureDetails(error, { ...context, httpStatus: status, responseBody: body })
  }
}
