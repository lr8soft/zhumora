import { useTranslation } from 'react-i18next'
import type { ProviderConfig } from '@shared/types'

export function ProviderAccessSettings({ provider, onChange }: {
  provider: ProviderConfig
  onChange: (updates: Partial<ProviderConfig>) => void
}) {
  const { t } = useTranslation()
  return <div className="form-field span-2">
    <label className="switch-row">
      <strong>{t('settings.providers.enabled')}</strong>
      <input type="checkbox" className="switch" checked={provider.enabled}
        onChange={event => onChange({ enabled: event.target.checked })} />
    </label>
    <label className="switch-row">
      <strong>{t('settings.providers.allowSubagents')}</strong>
      <input type="checkbox" className="switch" checked={provider.allowSubagents !== false}
        onChange={event => onChange({ allowSubagents: event.target.checked })} />
    </label>
    <p className="form-hint">{t('settings.providers.allowSubagentsHint')}</p>
  </div>
}
