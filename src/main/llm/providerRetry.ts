import { isRetriableError } from '../net/retryCore.ts'
import { isMalformedToolArgumentsError } from './errors.ts'
import { IncompleteStreamError, ProviderStreamError } from './streamErrors.ts'

/** Only rate limiting is classified as provider busy; validation failures stay terminal. */
export function isProviderBusyError(error: unknown): boolean {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined
  return status === 429
}

export function shouldRetryProviderError(error: unknown): boolean {
  if (error instanceof IncompleteStreamError || isMalformedToolArgumentsError(error)) return false
  if (error instanceof ProviderStreamError) return isProviderBusyError(error)
  return isProviderBusyError(error) || isRetriableError(error)
}
