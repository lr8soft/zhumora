import { createHash } from 'node:crypto'
import type { ProviderConfig } from '../../shared/types.ts'
import { providerRequestIdentity } from '../../shared/providerHeaders.ts'

export function providerDiscoveryCacheKey(provider: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'headers'>): string {
  return createHash('sha256').update(providerRequestIdentity(provider)).digest('hex')
}
