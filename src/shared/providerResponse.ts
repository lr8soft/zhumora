export interface ProviderResponseOptions {
  completionReview?: boolean
  captureResponses?: boolean
  reasoningHistory?: 'auto' | 'omit' | 'preserve'
}

export function normalizeProviderResponseOptions(value: ProviderResponseOptions): Required<ProviderResponseOptions> {
  return { completionReview: value.completionReview !== false, captureResponses: value.captureResponses === true,
    reasoningHistory: value.reasoningHistory === 'omit' || value.reasoningHistory === 'preserve' ? value.reasoningHistory : 'auto' }
}

export function validateProviderResponseOptions(value: ProviderResponseOptions): void {
  for (const field of ['completionReview', 'captureResponses'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error('Invalid provider ' + field)
  }
  if (value.reasoningHistory !== undefined && !['auto', 'omit', 'preserve'].includes(value.reasoningHistory)) {
    throw new Error('Invalid provider reasoningHistory')
  }
}
