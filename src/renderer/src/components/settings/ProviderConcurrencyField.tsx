import { useTranslation } from 'react-i18next'
import { isValidProviderConcurrency } from '@shared/providerConcurrency'

export default function ProviderConcurrencyField({ id, value, onChange }: {
  id: string; value?: number | null; onChange: (value: number | null) => void
}) {
  const { t } = useTranslation()
  const invalid = !isValidProviderConcurrency(value)
  return <div className="provider-block-field">
    <label className="form-label" htmlFor={`provider-concurrency-${id}`}>{t('settings.providers.maxConcurrency')}</label>
    <input id={`provider-concurrency-${id}`} type="number" className="input-field" min={1} step={1} inputMode="numeric"
      value={value ?? ''} placeholder={t('settings.providers.concurrencyUnlimited')} aria-invalid={invalid}
      onChange={event => onChange(event.currentTarget.value === '' ? null : Number(event.currentTarget.value))} />
    <p className="form-hint" style={invalid ? { color: 'var(--app-color-danger)' } : undefined}>
      {t(invalid ? 'settings.providers.concurrencyInvalid' : 'settings.providers.concurrencyHint')}
    </p>
  </div>
}
