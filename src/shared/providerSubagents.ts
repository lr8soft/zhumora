import type { ProviderConfig } from './types.ts'

/** Missing in legacy settings means allowed; malformed flags must not silently permit billing. */
export function normalizeProviderSubagentAccess(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'boolean') throw new Error('Invalid provider allowSubagents: expected a boolean')
  return value
}

export function canUseSubagentProvider(provider: ProviderConfig): boolean {
  return provider.enabled && normalizeProviderSubagentAccess(provider.allowSubagents)
}

export function assertSubagentProvider(providers: readonly ProviderConfig[], providerId: string): ProviderConfig {
  const provider = providers.find(item => item.id === providerId && item.enabled)
  if (!provider) throw new Error('Subagent provider is unknown or disabled. Use list_subagent_providers.')
  if (!canUseSubagentProvider(provider)) {
    throw new Error('This provider does not allow subagents. Select an allowed child model in Settings → General → Agent behavior; no automatic provider fallback is performed.')
  }
  return provider
}
