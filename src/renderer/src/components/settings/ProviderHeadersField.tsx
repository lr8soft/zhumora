import { useTranslation } from 'react-i18next'
import { formatProviderHeaders } from '@shared/providerHeaders'

export interface ProviderHeaderDraft {
  text: string
  invalid: boolean
}

interface Props {
  headers?: Record<string, string>
  draft?: ProviderHeaderDraft
  onChange: (text: string) => void
}

export function ProviderHeadersField({ headers, draft, onChange }: Props) {
  const { t } = useTranslation()
  return (
    <div className="form-field span-2">
      <label className="form-label">{t('settings.providers.customHeaders')}</label>
      <textarea
        className="input-field mono"
        rows={3}
        value={draft?.text ?? formatProviderHeaders(headers)}
        onChange={event => onChange(event.target.value)}
        aria-label={t('settings.providers.customHeaders')}
        aria-invalid={draft?.invalid || undefined}
        placeholder={'X-API-Key: your-key\nAuthorization: Token your-token'}
        spellCheck={false}
        autoComplete="off"
      />
      <p className="form-hint">{t('settings.providers.customHeadersHint')}</p>
      {draft?.invalid && <p className="form-hint" role="alert" style={{ color: 'var(--app-color-danger)' }}>
        {t('settings.providers.customHeadersInvalid')}
      </p>}
    </div>
  )
}
