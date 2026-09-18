import { useEffect, useMemo, useState } from 'react'
import { Copy, KeyRound, Network, PlugZap } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AutoApproveMode, McpServerInboundConfig } from '@shared/types'

interface Props {
  config: McpServerInboundConfig
  onChange: (config: McpServerInboundConfig) => void
}

export function McpServerSettings({ config, onChange }: Props) {
  const { t } = useTranslation()
  const [portDraft, setPortDraft] = useState(String(config.port))
  const [tokenCopied, setTokenCopied] = useState(false)
  const [jsonCopied, setJsonCopied] = useState(false)
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

  // 生效令牌：手动值优先；空 = 自动模式，取运行中服务器回显的值
  const effectiveToken = config.token || (status?.state === 'connected' ? status.token : null)

  // 真正生成一个令牌（与主进程同规格：24 字节 base64url）写入草稿
  const generateToken = () => {
    const bytes = new Uint8Array(24)
    crypto.getRandomValues(bytes)
    const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    onChange({ ...config, token })
  }

  const copyToken = async () => {
    if (!effectiveToken) return
    try {
      await navigator.clipboard.writeText(effectiveToken)
      setTokenCopied(true)
      setTimeout(() => setTokenCopied(false), 1600)
    } catch { /* clipboard unavailable */ }
  }

  const jsonConfig = useMemo(() => {
    // url 由主进程回报（含真实端口）；connected 时端口必然已解析
    const url = status?.state === 'connected' ? status.url : null
    if (!url || !effectiveToken) return null
    return JSON.stringify({
      mcpServers: {
        zhumora: {
          url,
          headers: { Authorization: `Bearer ${effectiveToken ?? ''}` }
        }
      }
    }, null, 2)
  }, [status, effectiveToken])

  const copyJson = async () => {
    if (!jsonConfig) return
    try {
      await navigator.clipboard.writeText(jsonConfig)
      setJsonCopied(true)
      setTimeout(() => setJsonCopied(false), 1600)
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
              style={{ flex: 1, minWidth: 0 }}
            />
            <button
              className="btn-ghost"
              type="button"
              title={t('settings.mcpServer.generateToken')}
              onClick={generateToken}
            >
              <KeyRound size={14} />
              {t('settings.mcpServer.generateToken')}
            </button>
            <button
              className="btn-ghost"
              type="button"
              title={t('settings.mcpServer.copyToken')}
              disabled={!effectiveToken}
              onClick={copyToken}
            >
              <Copy size={14} />
              {tokenCopied ? t('settings.mcpServer.copied') : t('settings.mcpServer.copyToken')}
            </button>
          </div>
          <p className="form-hint">{t('settings.mcpServer.tokenHint')}</p>
          {!effectiveToken && config.enabled && (
            <p className="form-hint" style={{ marginTop: 4 }}>{t('settings.mcpServer.tokenWaitHint')}</p>
          )}
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

      {config.enabled && (
        <section className="settings-section">
          <div className="settings-section-title">
            <Network size={16} />
            <div>
              <h3>{t('settings.mcpServer.connect')}</h3>
              <p>{t('settings.mcpServer.connectHint')}</p>
            </div>
          </div>

          <p className="form-hint" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: status?.state === 'connected'
                ? 'var(--app-color-success, #3a9e5f)'
                : status?.state === 'failed' ? 'var(--app-color-danger)' : 'var(--app-color-warning, #c9922a)'
            }} />
            {status
              ? t(`settings.mcpServer.state${status.state === 'connected' ? 'connected' : status.state === 'failed' ? 'failed' : 'connecting'}`)
              : t('settings.mcpServer.stateconnecting')}
            {status?.url && <span className="mono">{status.url}</span>}
            {status?.error && <span style={{ color: 'var(--app-color-danger)' }}>{status.error}</span>}
          </p>
          {status?.state === 'connected' && config.token === '' && (
            <p className="form-hint" style={{ marginTop: 4 }}>{t('settings.mcpServer.autoTokenNote')}</p>
          )}

          {jsonConfig ? (
            <div className="form-field" style={{ marginTop: 12 }}>
              <div className="mcp-json-header">
                <label className="form-label">{t('settings.mcpServer.jsonConfig')}</label>
                <button className="btn-ghost" type="button" onClick={copyJson}>
                  <Copy size={13} />
                  {jsonCopied ? t('settings.mcpServer.copied') : t('settings.mcpServer.copyJson')}
                </button>
              </div>
              <pre className="tool-call-pre">{jsonConfig}</pre>
              <p className="form-hint">{t('settings.mcpServer.jsonHint')}</p>
            </div>
          ) : (
            <p className="form-hint" style={{ marginTop: 12 }}>{t('settings.mcpServer.jsonNotReady')}</p>
          )}
        </section>
      )}
    </div>
  )
}
