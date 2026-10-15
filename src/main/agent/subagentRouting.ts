import type { AppSettings, ProviderConfig } from '../../shared/types.ts'
import type { SubagentModelSelection } from '../../shared/subagents.ts'
import type { ProviderRequestLoad } from '../../shared/providerConcurrency.ts'
import { normalizeProviderConcurrency } from '../../shared/providerConcurrency.ts'
import { assertSubagentProvider, canUseSubagentProvider } from '../../shared/providerSubagents.ts'

type RoutingSettings = Pick<AppSettings, 'providers' | 'subagentModels' | 'subagentDispatch'>
type ModelOverride = Partial<SubagentModelSelection>

/** Public discovery and prompt guidance use the same eligibility/limit projection, without credentials. */
export function subagentProviderChoices(providers: readonly ProviderConfig[]) {
  return providers.filter(canUseSubagentProvider).map(({ id, name, defaultModel, maxConcurrency }) =>
    ({ id, name, defaultModel, maxConcurrency: normalizeProviderConcurrency(maxConcurrency) }))
}

/** Snapshot of placements from SessionService.active; never a second active-run registry. */
export function assignedSubagentProviders(runs: Iterable<{ subagentProviderId?: string }>): Record<string, number> {
  const counts: Record<string, number> = Object.create(null)
  for (const run of runs) if (run.subagentProviderId) counts[run.subagentProviderId] = (counts[run.subagentProviderId] ?? 0) + 1
  return counts
}

/** Owns only the round-robin cursor, scoped to one SessionService and reset by effective routing changes. */
export class SubagentModelRouter {
  private configuration = ''
  private lastProvider: string | undefined

  select(settings: RoutingSettings, parent: SubagentModelSelection, request: ModelOverride,
    requests: Record<string, ProviderRequestLoad> = {}, assignments: Record<string, number> = {}): SubagentModelSelection {
    if (request.providerId) {
      const provider = assertSubagentProvider(settings.providers, request.providerId)
      const saved = settings.subagentModels.find(item => item.providerId === provider.id)
      const model = request.model ?? saved?.model ?? (provider.id === parent.providerId ? parent.model : provider.defaultModel)
      if (!model?.trim()) throw new Error('Subagent provider has no default model.')
      return { providerId: provider.id, model }
    }
    const candidates = (settings.subagentModels.length ? settings.subagentModels : [parent]).filter(item =>
      settings.providers.some(provider => provider.id === item.providerId && canUseSubagentProvider(provider)))
    if (!candidates.length) {
      assertSubagentProvider(settings.providers, settings.subagentModels[0]?.providerId ?? parent.providerId)
      throw new Error('Subagent model sequence has no enabled, allowed provider. Update Settings.')
    }
    // Models under one provider share capacity and one rotation position; its first model has priority.
    const unique = candidates.filter((item, index) => candidates.findIndex(other => other.providerId === item.providerId) === index)
    const configuration = JSON.stringify([settings.subagentDispatch, unique])
    if (configuration !== this.configuration) { this.configuration = configuration; this.lastProvider = undefined }
    const available = unique.filter(item => {
      const provider = assertSubagentProvider(settings.providers, item.providerId)
      const limit = normalizeProviderConcurrency(provider.maxConcurrency)
      const network = requests[item.providerId]
      // Active/preparing children cover the interval before their first request reaches the network gate.
      // This is placement advice, not a child-count cap; tools/permission waits can make it conservative.
      const load = Math.max((network?.active ?? 0) + (network?.waiting ?? 0), assignments[item.providerId] ?? 0)
      return limit === null || load < limit
    })
    const choices = available.length ? available : unique
    const previous = unique.findIndex(item => item.providerId === this.lastProvider)
    const ordered = settings.subagentDispatch === 'spread' && previous >= 0
      ? [...unique.slice(previous + 1), ...unique.slice(0, previous + 1)] : unique
    const selected = ordered.find(item => choices.includes(item))!
    const model = request.model ?? selected.model
    if (!model?.trim()) throw new Error('Subagent model is empty.')
    this.lastProvider = selected.providerId
    // When all are occupied the selected child's requests wait in the existing cancelable FIFO.
    return { providerId: selected.providerId, model }
  }
}
