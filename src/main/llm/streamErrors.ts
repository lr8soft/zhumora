/** A clean HTTP EOF/DONE without the selected choice's finish_reason is still incomplete. */
export class IncompleteStreamError extends Error {
  constructor() {
    super('LLM stream ended before finish_reason')
    this.name = 'IncompleteStreamError'
  }
}

/** Do not expose raw provider payloads (which may contain request data or credentials). */
export class ProviderStreamError extends Error {
  constructor(detail: 'payload' | 'provider' | 'content_type') {
    super(detail === 'provider' ? 'LLM provider reported an error inside the response stream'
      : detail === 'content_type' ? 'LLM provider returned a non-SSE response to a streaming request'
        : 'LLM provider returned an invalid chat completion stream payload')
    this.name = 'ProviderStreamError'
  }
}
