import type { ProviderConfig } from '../../shared/types.ts'
import type { SubagentModelSelection } from '../../shared/subagents.ts'
import { canUseSubagentProvider } from '../../shared/providerSubagents.ts'

export interface SubagentModelOption {
  value: string
  providerId: string
  providerName: string
  model: string
  unavailable: boolean
}

/** UI projection retains saved selections when catalogs fail or a provider is removed. */
export function buildSubagentModelOptions(
  providers: ProviderConfig[], catalogs: Record<string, { id: string }[]>, selected: readonly SubagentModelSelection[]
): SubagentModelOption[] {
  const options: SubagentModelOption[] = []
  for (const provider of providers.filter(canUseSubagentProvider)) {
    const models = [provider.defaultModel, ...(catalogs[provider.id] || []).map(item => item.id),
      ...selected.filter(item => item.providerId === provider.id).map(item => item.model)]
    for (const model of new Set(models)) {
      if (!model?.trim() || model.length > 200) continue
      options.push({ value: JSON.stringify([provider.id, model]), providerId: provider.id, providerName: provider.name, model, unavailable: false })
    }
  }
  for (const item of selected) if (!options.some(option => option.providerId === item.providerId && option.model === item.model)) {
    options.push({ value: JSON.stringify([item.providerId, item.model]), ...item,
      providerName: providers.find(provider => provider.id === item.providerId)?.name || item.providerId, unavailable: true })
  }
  return options
}
