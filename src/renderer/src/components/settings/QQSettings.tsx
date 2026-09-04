import { useEffect, useState } from 'react'
import { Bot, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AutoApproveMode, QQBotConfig } from '@shared/types'
import { formatQQUserIds, parseQQUserIds } from '@shared/qq'

interface Props {
  config: QQBotConfig
  onChange: (config: QQBotConfig) => void
}

const QQ_BOT_PLATFORM_URL = 'https://q.qq.com/'

export function QQSettings({ config, onChange }: Props) {
  const { t } = useTranslation()
  const [allowedUsersDraft, setAllowedUsersDraft] = useState(() => formatQQUserIds(config.allowedUserIds))
  const [testState, setTestState] = useState<{ loading: boolean; message?: string; error?: boolean }>({ loading: false })

  useEffect(() => {
    setAllowedUsersDraft(formatQQUserIds(config.allowedUserIds))
  }, [config.allowedUserIds])

  const commitAllowedUsers = () => {
    const allowedUserIds = parseQQUserIds(allowedUsersDraft)
    setAllowedUsersDraft(formatQQUserIds(allowedUserIds))
    onChange({ ...config, allowedUserIds })
  }

  const testConnection = async () => {
    setTestState({ loading: true })
    const result = await window.api.bot.test('qq', config)
    if (result.ok && result.bot) {
      setTestState({ loading: false, message: t('settings.qq.connected', { identity: result.bot.name }) })
    } else {
      setTestState({ loading: false, message: result.error || t('settings.qq.failed'), error: true })
    }
  }

  const approvalHintKey = ({
    manual: 'chat.approveManualHint',
    auto: 'chat.approveAutoHint',
    full: 'chat.approveFullHint'
  } as const)[config.approveMode]

  return (
    <div>
      <p className="form-hint" style={{ marginBottom: 14 }}>{t('settings.qq.hint')}</p>

      <section className="settings-section">
        <div className="switch-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Bot size={16} style={{ color: 'var(--app-color-primary-strong)', flex: '0 0 auto' }} />
            <strong>{t('settings.qq.enabled')}</strong>
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
            <h3>{t('settings.qq.credentials')}</h3>
            <p>{t('settings.qq.credentialsHint')}</p>
          </div>
        </div>

        <button
          className="btn-ghost"
          type="button"
          onClick={() => window.api.settings.openExternal(QQ_BOT_PLATFORM_URL)}
          style={{ marginBottom: 14 }}
        >
          <ExternalLink size={13} />
          {t('settings.qq.createBot')}
        </button>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
          <div className="form-field">
            <label className="form-label">{t('settings.qq.appId')}</label>
            <input
              className="input-field mono"
              value={config.appId}
              onChange={(event) => onChange({ ...config, appId: event.target.value })}
              autoComplete="off"
            />
          </div>
          <div className="form-field">
            <label className="form-label">{t('settings.qq.appSecret')}</label>
            <input
              className="input-field mono"
              type="password"
              value={config.appSecret}
              onChange={(event) => onChange({ ...config, appSecret: event.target.value })}
              autoComplete="off"
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button
            className="btn-ghost"
            type="button"
            onClick={testConnection}
            disabled={testState.loading || !config.appId.trim() || !config.appSecret.trim()}
          >
            {testState.loading && <Loader2 size={13} className="spin" />}
            {testState.loading ? t('settings.qq.testing') : t('settings.qq.test')}
          </button>
          {testState.message && (
            <span className="form-hint" style={{ color: testState.error ? 'var(--app-color-danger)' : undefined }}>
              {testState.message}
            </span>
          )}
        </div>

        <div className="form-field" style={{ marginTop: 12 }}>
          <label className="form-label">{t('settings.qq.allowedUsers')}</label>
          <textarea
            className="input-field mono"
            rows={5}
            value={allowedUsersDraft}
            onChange={(event) => setAllowedUsersDraft(event.target.value)}
            onBlur={commitAllowedUsers}
            placeholder={'USER_OPENID_1\nUSER_OPENID_2'}
          />
          <p className="form-hint">{t('settings.qq.allowedUsersHint')}</p>
        </div>

        <div className="form-field" style={{ marginTop: 12 }}>
          <label className="form-label">{t('settings.qq.approveMode')}</label>
          <select
            className="input-field"
            value={config.approveMode}
            onChange={(event) => onChange({ ...config, approveMode: event.target.value as AutoApproveMode })}
          >
            <option value="manual">{t('chat.approveManual')}</option>
            <option value="auto">{t('chat.approveAuto')}</option>
            <option value="full">{t('chat.approveFull')}</option>
          </select>
          <p className="form-hint">{t(approvalHintKey)}</p>
        </div>
      </section>
    </div>
  )
}
