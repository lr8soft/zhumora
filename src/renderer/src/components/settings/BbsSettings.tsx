import { useState } from 'react'
import { Loader2, MessagesSquare, RefreshCw, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { BbsConfig } from '@shared/bbs'

interface Props {
  config: BbsConfig
  onChange: (config: BbsConfig) => void
}

interface TestState {
  loading: boolean
  message?: string
  error?: boolean
}

export function BbsSettings({ config, onChange }: Props) {
  const { t } = useTranslation()
  const [accountDraft, setAccountDraft] = useState({ username: '', password: '', displayName: '' })
  const [testState, setTestState] = useState<TestState>({ loading: false })
  const [registerState, setRegisterState] = useState<TestState>({ loading: false })

  const testHealth = async () => {
    setTestState({ loading: true })
    const result = await window.api.bbs.health(config.baseUrl)
    if (result.ok) {
      setTestState({ loading: false, message: t('settings.bbs.healthy') })
    } else {
      setTestState({ loading: false, message: result.error || t('settings.bbs.unhealthy'), error: true })
    }
  }

  const doRegister = async () => {
    if (accountDraft.username.trim().length < 3) {
      setRegisterState({ loading: false, message: t('settings.bbs.usernameTooShort'), error: true })
      return
    }
    if (accountDraft.password.length < 8) {
      setRegisterState({ loading: false, message: t('settings.bbs.passwordTooShort'), error: true })
      return
    }
    setRegisterState({ loading: true })
    const result = await window.api.bbs.register(config, accountDraft.username, accountDraft.password, accountDraft.displayName)
    if (result.token && result.profile) {
      // token 只返回这一次：立即写回草稿，随"保存设置"落库
      onChange({
        ...config,
        token: result.token,
        canPost: result.profile.can_post,
        canJoinActivities: result.profile.can_join_activities
      })
      setAccountDraft({ username: '', password: '', displayName: '' })
      setRegisterState({ loading: false, message: t('settings.bbs.registered', { name: result.profile.display_name }) })
    } else {
      setRegisterState({ loading: false, message: result.error || t('settings.bbs.registerFailed'), error: true })
    }
  }

  const doLogin = async () => {
    setRegisterState({ loading: true })
    const result = await window.api.bbs.login(config, accountDraft.username, accountDraft.password)
    if (result.token && result.profile) {
      onChange({
        ...config,
        token: result.token,
        canPost: result.profile.can_post,
        canJoinActivities: result.profile.can_join_activities
      })
      setAccountDraft({ username: '', password: '', displayName: '' })
      setRegisterState({ loading: false, message: t('settings.bbs.registered', { name: result.profile.display_name }) })
    } else {
      setRegisterState({ loading: false, message: result.error || t('settings.bbs.registerFailed'), error: true })
    }
  }

  const hasAccount = config.token !== ''

  return (
    <div>
      <p className="form-hint" style={{ marginBottom: 14 }}>{t('settings.bbs.hint')}</p>

      <section className="settings-section">
        <div className="switch-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <MessagesSquare size={16} style={{ color: 'var(--app-color-primary-strong)', flex: '0 0 auto' }} />
            <strong>{t('settings.bbs.enabled')}</strong>
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
          <MessagesSquare size={16} />
          <div>
            <h3>{t('settings.bbs.server')}</h3>
            <p>{t('settings.bbs.serverHint')}</p>
          </div>
        </div>

        <div className="form-field">
          <label className="form-label">{t('settings.bbs.baseUrl')}</label>
          <input
            className="input-field mono"
            value={config.baseUrl}
            onChange={(event) => onChange({ ...config, baseUrl: event.target.value })}
            placeholder="http://127.0.0.1:8000"
            autoComplete="off"
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <button
            className="btn-ghost"
            type="button"
            onClick={testHealth}
            disabled={testState.loading || !config.baseUrl.trim()}
          >
            {testState.loading && <Loader2 size={13} className="spin" />}
            <RefreshCw size={13} />
            {t('settings.bbs.test')}
          </button>
          {testState.message && (
            <span className="form-hint" style={{ color: testState.error ? 'var(--app-color-danger)' : undefined }}>
              {testState.message}
            </span>
          )}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <ShieldCheck size={16} />
          <div>
            <h3>{t('settings.bbs.account')}</h3>
            <p>{t('settings.bbs.accountHint')}</p>
          </div>
        </div>

        {hasAccount ? (
          <p className="form-hint" style={{ color: 'var(--app-color-success, #2e9e5b)' }}>
            {t('settings.bbs.tokenSet')}
          </p>
        ) : (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
              <div className="form-field">
                <label className="form-label">{t('settings.bbs.username')}</label>
                <input
                  className="input-field mono"
                  value={accountDraft.username}
                  onChange={(event) => setAccountDraft({ ...accountDraft, username: event.target.value })}
                  autoComplete="off"
                />
              </div>
              <div className="form-field">
                <label className="form-label">{t('settings.bbs.displayName')}</label>
                <input
                  className="input-field"
                  value={accountDraft.displayName}
                  onChange={(event) => setAccountDraft({ ...accountDraft, displayName: event.target.value })}
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="form-field" style={{ marginTop: 12 }}>
              <label className="form-label">{t('settings.bbs.password')}</label>
              <input
                className="input-field mono"
                type="password"
                value={accountDraft.password}
                onChange={(event) => setAccountDraft({ ...accountDraft, password: event.target.value })}
                autoComplete="new-password"
              />
              <p className="form-hint">{t('settings.bbs.passwordHint')}</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <button className="btn-primary" type="button" onClick={doRegister} disabled={registerState.loading}>
                {registerState.loading && <Loader2 size={13} className="spin" />}
                {t('settings.bbs.register')}
              </button>
              <button className="btn-ghost" type="button" onClick={doLogin} disabled={registerState.loading}>
                {t('settings.bbs.login')}
              </button>
              {registerState.message && (
                <span className="form-hint" style={{ color: registerState.error ? 'var(--app-color-danger)' : 'var(--app-color-success, #2e9e5b)' }}>
                  {registerState.message}
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <MessagesSquare size={16} />
          <div>
            <h3>{t('settings.bbs.permissions')}</h3>
            <p>{t('settings.bbs.permissionsHint')}</p>
          </div>
        </div>

        <div className="switch-row">
          <div>
            <strong>{t('settings.bbs.canPost')}</strong>
            <p className="form-hint">{t('settings.bbs.canPostHint')}</p>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={config.canPost}
            onChange={(event) => onChange({ ...config, canPost: event.target.checked })}
          />
        </div>

        <div className="switch-row">
          <div>
            <strong>{t('settings.bbs.canJoinActivities')}</strong>
            <p className="form-hint">{t('settings.bbs.canJoinActivitiesHint')}</p>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={config.canJoinActivities}
            onChange={(event) => onChange({ ...config, canJoinActivities: event.target.checked })}
          />
        </div>

        <div className="form-field" style={{ marginTop: 12 }}>
          <label className="form-label">{t('settings.bbs.pollInterval')}</label>
          <input
            className="input-field mono"
            type="number"
            min={0}
            max={3600}
            value={config.pollIntervalSec}
            onChange={(event) => onChange({ ...config, pollIntervalSec: Math.max(0, Number(event.target.value) || 0) })}
          />
          <p className="form-hint">{t('settings.bbs.pollIntervalHint')}</p>
        </div>
      </section>
    </div>
  )
}
