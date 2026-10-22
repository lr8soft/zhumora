export interface ProviderResponseOptions {
  captureResponses?: boolean
  reasoningHistory?: 'auto' | 'omit' | 'preserve'
  outputTokenParameter?: 'auto' | 'max_tokens' | 'max_completion_tokens'
}

export function normalizeProviderResponseOptions(value: ProviderResponseOptions): Required<ProviderResponseOptions> {
  return { captureResponses: value.captureResponses === true,
    reasoningHistory: value.reasoningHistory === 'omit' || value.reasoningHistory === 'preserve' ? value.reasoningHistory : 'auto',
    outputTokenParameter: value.outputTokenParameter === 'max_tokens' || value.outputTokenParameter === 'max_completion_tokens'
      ? value.outputTokenParameter : 'auto' }
}

export function validateProviderResponseOptions(value: ProviderResponseOptions): void {
  if (value.captureResponses !== undefined && typeof value.captureResponses !== 'boolean') throw new Error('Invalid provider captureResponses')
  if (value.reasoningHistory !== undefined && !['auto', 'omit', 'preserve'].includes(value.reasoningHistory)) {
    throw new Error('Invalid provider reasoningHistory')
  }
  if (value.outputTokenParameter !== undefined && !['auto', 'max_tokens', 'max_completion_tokens'].includes(value.outputTokenParameter)) {
    throw new Error('Invalid provider outputTokenParameter')
  }
}
