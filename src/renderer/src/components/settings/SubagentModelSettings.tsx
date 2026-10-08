import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import type { ProviderConfig } from '@shared/types'
import type { SubagentModelSelection } from '@shared/subagents'
import { buildSubagentModelOptions } from '../../subagentModelOptions'
import { useSubagentModelCatalog } from './useSubagentModelCatalog'

interface Props {
  providers: ProviderConfig[]
  selection: SubagentModelSelection | null
  enabled: boolean
  onChange: (selection: SubagentModelSelection | null) => void
}

export function SubagentModelSettings({ providers, selection, enabled, onChange }: Props) {
  const { t } = useTranslation()
  const catalog = useSubagentModelCatalog(providers, enabled)
  const options = buildSubagentModelOptions(providers, catalog.models, selection)
  const groups = [...new Set(options.map(option => option.providerId))]
  return (
    <div className="form-field" style={{ marginTop: 16 }}>
      <label className="form-label" htmlFor="subagent-model-select">{t('settings.general.subagentModel')}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <select id="subagent-model-select" className="input-field" style={{ flex: 1, minWidth: 0 }}
          disabled={!enabled} value={selection ? JSON.stringify([selection.providerId, selection.model]) : ''}
          onFocus={catalog.request} onChange={event => {
            const option = options.find(item => item.value === event.target.value)
            onChange(option ? { providerId: option.providerId, model: option.model } : null)
          }}>
          <option value="">{t('settings.general.subagentModelInherit')}</option>
          {groups.map(providerId => <optgroup key={providerId} label={options.find(option => option.providerId === providerId)!.providerName}>
            {options.filter(option => option.providerId === providerId).map(option =>
              <option key={option.value} value={option.value} disabled={option.unavailable}>
                {option.providerName} · {option.model}{option.unavailable ? ` (${t('settings.general.subagentModelUnavailable')})` : ''}
              </option>)}
          </optgroup>)}
        </select>
        <button type="button" className="btn-ghost" disabled={!enabled || catalog.loading}
          onClick={catalog.refresh} aria-label={t('settings.providers.modelRefresh')} title={t('settings.providers.modelRefresh')}>
          <RefreshCw size={14} />
        </button>
      </div>
      <p className="form-hint">{t('settings.general.subagentsModelsHint')}</p>
      {catalog.loading && <p className="form-hint">{t('settings.general.subagentModelsLoading')}</p>}
      {catalog.failed.length > 0 && <p className="form-hint">{t('settings.providers.modelLoadFailed')}: {catalog.failed.map(id => providers.find(provider => provider.id === id)?.name || id).join(', ')}</p>}
    </div>
  )
}
