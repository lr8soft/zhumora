import { useEffect, useState } from 'react'
import type { ProviderConfig } from '@shared/types'

type ModelLists = Record<string, { id: string; name?: string }[]>

/** View-local cache: provider list identity invalidates it; refresh forces the existing main adapter to reload. */
export function useSubagentModelCatalog(providers: ProviderConfig[], enabled: boolean) {
  const [requested, setRequested] = useState(false)
  const [revision, setRevision] = useState(0)
  const [catalog, setCatalog] = useState<{ providers: ProviderConfig[] | null; models: ModelLists; failed: string[]; loading: boolean }>(
    { providers: null, models: {}, failed: [], loading: false })
  useEffect(() => {
    if (!requested || !enabled) {
      setCatalog(previous => previous.loading ? { ...previous, loading: false } : previous)
      return
    }
    let current = true
    const active = providers.filter(provider => provider.enabled)
    setCatalog({ providers, models: {}, failed: [], loading: true })
    void Promise.allSettled(active.map(provider => window.api.provider.listModels(provider, revision > 0))).then(results => {
      if (!current) return
      const models: ModelLists = {}; const failed: string[] = []
      results.forEach((result, index) => {
        const id = active[index].id
        if (result.status === 'fulfilled') {
          models[id] = result.value.models
          if (result.value.error) failed.push(id)
        } else failed.push(id)
      })
      setCatalog({ providers, models, failed, loading: false })
    })
    return () => { current = false }
  }, [providers, enabled, requested, revision])
  return {
    models: catalog.providers === providers ? catalog.models : {},
    failed: catalog.providers === providers ? catalog.failed : [],
    loading: catalog.loading,
    request: () => setRequested(true),
    refresh: () => { setRequested(true); setRevision(value => value + 1) }
  }
}
