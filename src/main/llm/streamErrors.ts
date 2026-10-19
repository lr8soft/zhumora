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
  constructor(detail: 'payload' | 'provider' | 'content_type', error?: unknown, context?: StreamErrorContext) {
    super(detail === 'provider' ? formatProviderStreamError(error, context)
      : detail === 'content_type' ? 'LLM provider returned a non-SSE response to a streaming request'
        : 'LLM provider returned an invalid chat completion stream payload')
    this.name = 'ProviderStreamError'
  }
}
