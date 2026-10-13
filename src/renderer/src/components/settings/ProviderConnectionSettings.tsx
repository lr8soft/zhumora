import { useTranslation } from 'react-i18next'
import type { ProviderConfig } from '@shared/types'
import { ProviderHeadersField, type ProviderHeaderDraft } from './ProviderHeadersField'

export function ProviderConnectionSettings({ provider: p, draft, onChange, onHeaderChange, onDetect }: {
  provider: ProviderConfig
  draft?: ProviderHeaderDraft
  onChange: (updates: Partial<ProviderConfig>) => void
  onHeaderChange: (text: string) => void
  onDetect: (provider: ProviderConfig) => Promise<void>
}) {
  const { t } = useTranslation()
  return <div className="provider-connection-fields">
    <div className="form-field">
      <label className="form-label" htmlFor={`provider-name-${p.id}`}>{t('settings.providers.name')}</label>
      <input id={`provider-name-${p.id}`} className="input-field" value={p.name} onChange={e => onChange({ name: e.target.value })} />
    </div>
    <div className="form-field">
      <label className="form-label" htmlFor={`provider-url-${p.id}`}>{t('settings.providers.baseUrl')}</label>
      <input id={`provider-url-${p.id}`} className="input-field mono" value={p.baseUrl}
        onChange={e => onChange({ baseUrl: e.target.value })} onBlur={() => void onDetect(p)} />
    </div>
    <div className="form-field">
      <label className="form-label" htmlFor={`provider-key-${p.id}`}>{t('settings.providers.apiKey')}</label>
      <input id={`provider-key-${p.id}`} className="input-field mono" type="password" value={p.apiKey || ''}
        autoComplete="off" placeholder={t('settings.providers.apiKeyPlaceholder')}
        onChange={e => onChange({ apiKey: e.target.value })} onBlur={() => void onDetect(p)} />
    </div>
    <details className="provider-disclosure" open={draft?.invalid || undefined}>
      <summary>{t('settings.providers.customHeaders')}
        {(draft?.text.trim() || Object.keys(p.headers || {}).length > 0) && <span className="provider-badge">{t('settings.providers.configured')}</span>}
      </summary>
      <ProviderHeadersField headers={p.headers} draft={draft} onChange={onHeaderChange} />
    </details>
  </div>
}
