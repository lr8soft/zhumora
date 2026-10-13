import type { ProviderConfig } from '../../shared/types'
import { getSettings } from '../store/db'
import { ProviderRequestConcurrency } from './requestConcurrency'

// This adapter owns the process-wide network permits. Idle provider entries are
// removed immediately; the composition root exposes settings refresh and shutdown.
export const providerRequests = new ProviderRequestConcurrency()

export async function withProviderRequest<T>(provider: ProviderConfig, signal: AbortSignal | undefined,
  execute: () => Promise<T>): Promise<T> {
  const saved = getSettings().providers.find(item => item.id === provider.id)
  const release = await providerRequests.acquire(provider.id, saved ? saved.maxConcurrency : provider.maxConcurrency, signal)
  try {
    signal?.throwIfAborted()
    return await execute()
  } finally { release() }
}
