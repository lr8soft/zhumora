import type { ProviderConfig } from '../../shared/types.ts'
import type { SubagentModelSelection } from '../../shared/subagents.ts'

export interface SubagentModelOption {
  value: string
  providerId: string
  providerName: string
  model: string
  unavailable: boolean
}

/** UI projection retains saved selections when catalogs fail or a provider is removed. */
export function buildSubagentModelOptions(
  providers: ProviderConfig[], catalogs: Record<string, { id: string }[]>, selected: SubagentModelSelection | null
): SubagentModelOption[] {
  const options: SubagentModelOption[] = []
  for (const provider of providers.filter(item => item.enabled)) {
    const models = [provider.defaultModel, ...(catalogs[provider.id] || []).map(item => item.id),
      ...(selected?.providerId === provider.id ? [selected.model] : [])]
    for (const model of new Set(models)) {
      if (!model?.trim() || model.length > 200) continue
      options.push({ value: JSON.stringify([provider.id, model]), providerId: provider.id, providerName: provider.name, model, unavailable: false })
    }
  }
  if (selected && !options.some(option => option.providerId === selected.providerId && option.model === selected.model)) {
    options.push({ value: JSON.stringify([selected.providerId, selected.model]), ...selected,
      providerName: providers.find(provider => provider.id === selected.providerId)?.name || selected.providerId, unavailable: true })
  }
  return options
}
