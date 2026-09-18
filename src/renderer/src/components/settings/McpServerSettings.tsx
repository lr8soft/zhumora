import { useEffect, useState } from 'react'
import { Copy, PlugZap, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AutoApproveMode, McpServerInboundConfig } from '@shared/types'

interface Props {
  config: McpServerInboundConfig
  onChange: (config: McpServerInboundConfig) => void
}

export function McpServerSettings({ config, onChange }: Props) {
  const { t } = useTranslation()
  const [portDraft, setPortDraft] = useState(String(config.port))
  const [copied, setCopied] = useState(false)
  const [status, setStatus] = useState<{ state: string; url: string | null; token: string | null; error: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      window.api.mcpServer.status().then(result => { if (!cancelled) setStatus(result) }).catch(() => {})
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [config.enabled])

  const commitPort = (value: string) => {
    const parsed = Number(value)
    const port = Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 0
    setPortDraft(String(port))
    onChange({ ...config, port })
  }

  const copyCommand = async () => {
    // 用 status 回显的生效 token（含自动生成的值）；config.token 在自动生成场景下是空的。
    if (!status?.url || !status.token) return
    const command = `claude mcp add zhumora --transport http ${status.url} -H "Authorization: Bearer ${status.token}"`
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { /* clipboard unavailable */ }
  }

  const approvalHintKey = ({
    manual: 'chat.approveManualHint',
    auto: 'chat.approveAutoHint',
    full: 'chat.approveFullHint'
  } as const)[config.approveMode]

  return (
    <div>
      <p className="form-hint" style={{ marginBottom: 14 }}>{t('settings.mcpServer.hint')}</p>

      <section className="settings-section">
        <div className="switch-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <PlugZap size={16} style={{ color: 'var(--app-color-primary-strong)', flex: '0 0 auto' }} />
            <strong>{t('settings.mcpServer.enabled')}</strong>
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
          <PlugZap size={16} />
          <div>
            <h3>{t('settings.mcpServer.access')}</h3>
            <p>{t('settings.mcpServer.accessHint')}</p>
          </div>
        </div>

        <div className="form-field">
          <label className="form-label">{t('settings.mcpServer.port')}</label>
          <input
            className="input-field mono"
            type="number"
            min={0}
            max={65535}
            value={portDraft}
            onChange={(event) => setPortDraft(event.target.value)}
            onBlur={() => commitPort(portDraft)}
            onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }}
          />
          <p className="form-hint">{t('settings.mcpServer.portHint')}</p>
        </div>

        <div className="form-field" style={{ marginTop: 12 }}>
          <label className="form-label">{t('settings.mcpServer.token')}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input-field mono"
              type="password"
              value={config.token}
              onChange={(event) => onChange({ ...config, token: event.target.value })}
              placeholder={t('settings.mcpServer.tokenPlaceholder')}
              autoComplete="off"
            />
            <button
              className="btn-ghost"
              type="button"
              title={t('settings.mcpServer.regenerate')}
              onClick={() => onChange({ ...config, token: '' })}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <p className="form-hint">{t('settings.mcpServer.tokenHint')}</p>
        </div>

        <div className="form-field" style={{ marginTop: 12 }}>
          <label className="form-label">{t('settings.mcpServer.label')}</label>
          <input
            className="input-field"
            value={config.clientLabel}
            onChange={(event) => onChange({ ...config, clientLabel: event.target.value })}
            maxLength={32}
          />
          <p className="form-hint">{t('settings.mcpServer.labelHint')}</p>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <PlugZap size={16} />
          <div>
            <h3>{t('settings.mcpServer.permissions')}</h3>
            <p>{t('settings.mcpServer.permissionsHint')}</p>
          </div>
        </div>

        <div className="form-field">
          <label className="form-label">{t('settings.mcpServer.permissionMode')}</label>
          <select
            className="input-field"
            value={config.permissionMode}
            onChange={(event) => onChange({ ...config, permissionMode: event.target.value as 'ui' | 'delegate' })}
          >
            <option value="ui">{t('settings.mcpServer.modeUi')}</option>
            <option value="delegate">{t('settings.mcpServer.modeDelegate')}</option>
          </select>
          <p className="form-hint">{t(`settings.mcpServer.mode${config.permissionMode === 'delegate' ? 'Delegate' : 'Ui'}Hint`)}</p>
        </div>

        <div className="form-field" style={{ marginTop: 12 }}>
          <label className="form-label">{t('settings.mcpServer.approveMode')}</label>
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

      {status && status.state !== 'stopped' && (
        <section className="settings-section">
          <p className="form-hint" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: status.state === 'connected'
                ? 'var(--app-color-success, #3a9e5f)'
                : status.state === 'failed' ? 'var(--app-color-danger)' : 'var(--app-color-warning, #c9922a)'
            }} />
            {t(`settings.mcpServer.state${status.state === 'connected' ? 'connected' : status.state === 'failed' ? 'failed' : 'connecting'}`)}
            {status.url && <span className="mono">{status.url}</span>}
            {status.error && <span style={{ color: 'var(--app-color-danger)' }}>{status.error}</span>}
          </p>
          {status.state === 'connected' && config.token === '' && (
            <p className="form-hint" style={{ marginTop: 4 }}>{t('settings.mcpServer.autoTokenNote')}</p>
          )}
          {status.url && status.state === 'connected' && status.token && (
            <button className="btn-ghost" type="button" onClick={copyCommand}>
              <Copy size={13} />
              {copied ? t('settings.mcpServer.copied') : t('settings.mcpServer.copyCommand')}
            </button>
          )}
        </section>
      )}
    </div>
  )
}
