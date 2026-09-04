import { useEffect, useState } from 'react'
import { Bot, Loader2, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TelegramBotConfig } from '@shared/types'
import { formatTelegramUserIds, parseTelegramUserIds } from '@shared/telegram'

interface Props {
  config: TelegramBotConfig
  onChange: (config: TelegramBotConfig) => void
}

export function TelegramSettings({ config, onChange }: Props) {
  const { t } = useTranslation()
  const [allowedUsersDraft, setAllowedUsersDraft] = useState(() => formatTelegramUserIds(config.allowedUserIds))
  const [testState, setTestState] = useState<{ loading: boolean; message?: string; error?: boolean }>({ loading: false })

  useEffect(() => {
    setAllowedUsersDraft(formatTelegramUserIds(config.allowedUserIds))
  }, [config.allowedUserIds])

  const commitAllowedUsers = () => {
    const allowedUserIds = parseTelegramUserIds(allowedUsersDraft)
    setAllowedUsersDraft(formatTelegramUserIds(allowedUserIds))
    onChange({ ...config, allowedUserIds })
  }

  const testConnection = async () => {
    setTestState({ loading: true })
    const result = await window.api.telegram.test(config)
    if (result.ok && result.bot) {
      const identity = result.bot.username ? `@${result.bot.username}` : result.bot.name
      setTestState({ loading: false, message: t('settings.telegram.connected', { identity }) })
    } else {
      setTestState({ loading: false, message: result.error || t('settings.telegram.failed'), error: true })
    }
  }

  return (
    <div>
      <p className="form-hint" style={{ marginBottom: 14 }}>{t('settings.telegram.hint')}</p>

      <section className="settings-section">
        <div className="switch-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Bot size={16} style={{ color: 'var(--app-color-primary-strong)', flex: '0 0 auto' }} />
            <div>
              <strong>{t('settings.telegram.enabled')}</strong>
              <small>{t('settings.telegram.enabledHint')}</small>
            </div>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={config.enabled}
            onChange={(event) => onChange({ ...config, enabled: event.target.checked })}
          />
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <ShieldCheck size={16} />
          <div>
            <h3>{t('settings.telegram.credentials')}</h3>
            <p>{t('settings.telegram.credentialsHint')}</p>
          </div>
        </div>

        <div className="form-field">
          <label className="form-label">{t('settings.telegram.token')}</label>
          <input
            className="input-field mono"
            type="password"
            value={config.token}
            onChange={(event) => onChange({ ...config, token: event.target.value })}
            placeholder="123456789:AA..."
            autoComplete="off"
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <button className="btn-ghost" type="button" onClick={testConnection} disabled={testState.loading || !config.token.trim()}>
              {testState.loading && <Loader2 size={13} className="spin" />}
              {testState.loading ? t('settings.telegram.testing') : t('settings.telegram.test')}
            </button>
            {testState.message && (
              <span className="form-hint" style={{ color: testState.error ? 'var(--app-color-danger)' : undefined }}>
                {testState.message}
              </span>
            )}
          </div>
        </div>

        <div className="form-field" style={{ marginTop: 12 }}>
          <label className="form-label">{t('settings.telegram.allowedUsers')}</label>
          <textarea
            className="input-field mono"
            rows={5}
            value={allowedUsersDraft}
            onChange={(event) => setAllowedUsersDraft(event.target.value)}
            onBlur={commitAllowedUsers}
            placeholder={'123456789\n987654321'}
          />
          <p className="form-hint">{t('settings.telegram.allowedUsersHint')}</p>
        </div>
      </section>
    </div>
  )
}
