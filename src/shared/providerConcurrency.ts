/** The settings boundary accepts only an optional positive whole-number limit. */
export function isValidProviderConcurrency(input: unknown): input is number | null | undefined {
  return input === undefined || input === null || (typeof input === 'number' && Number.isSafeInteger(input) && input >= 1)
}

export function normalizeProviderConcurrency(input: unknown): number | null {
  if (input === undefined || input === null) return null
  if (!isValidProviderConcurrency(input)) {
    throw new Error('Invalid provider concurrency limit: enter a positive integer or leave empty')
  }
  return input
}
