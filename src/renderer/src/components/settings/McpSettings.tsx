import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import type { McpServerConfig } from '@shared/types'
import { formatMcpHeaders, parseMcpHeaders } from '@shared/mcpConfig'

interface Props {
  servers: McpServerConfig[]
  onChange: (servers: McpServerConfig[]) => void
}

interface CustomHeadersFieldProps {
  headers?: Record<string, string>
  label: string
  onChange: (headers: Record<string, string>) => void
}

function CustomHeadersField({ headers, label, onChange }: CustomHeadersFieldProps) {
  // Parsing on every keystroke would erase an incomplete line before the user
  // has a chance to type its colon and value, so keep the raw draft locally.
  const [draft, setDraft] = useState(() => formatMcpHeaders(headers))

  useEffect(() => {
    setDraft(formatMcpHeaders(headers))
  }, [headers])

  const commit = () => {
    const parsed = parseMcpHeaders(draft)
    setDraft(formatMcpHeaders(parsed))
    onChange(parsed)
  }

  return (
    <div className="form-field span-2">
      <label className="form-label">{label}</label>
      <textarea
        className="input-field mono"
        rows={3}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        placeholder={'Authorization: Bearer xxx\nX-Custom-Header: value'}
      />
    </div>
  )
}

export function McpSettings({ servers, onChange }: Props) {
  const { t } = useTranslation()
  const addServer = () => {
    const id = `mcp-${Date.now()}`
    const newServer: McpServerConfig = {
      id,
      name: 'New MCP Server',
      type: 'stdio',
      command: '',
      args: [],
      enabled: true
    }
    onChange([...servers, newServer])
  }

  const updateServer = (idx: number, updates: Partial<McpServerConfig>) => {
    const next = [...servers]
    next[idx] = { ...next[idx], ...updates }
    onChange(next)
  }

  const removeServer = (idx: number) => {
    onChange(servers.filter((_, i) => i !== idx))
  }

  return (
    <div>
      <p className="form-hint" style={{ marginBottom: 14 }}>{t('settings.mcp.hint')}</p>

      {servers.map((s, i) => (
        <div key={s.id} className="provider-card">
          <div className="provider-card-head">
            <span style={{ fontSize: '0.867rem', fontWeight: 650 }}>{s.name}</span>
            <button onClick={() => removeServer(i)} className="danger-link">
              <Trash2 size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              {t('settings.mcp.remove')}
            </button>
          </div>
          <div className="provider-fields">
            <div className="form-field">
              <label className="form-label">{t('settings.mcp.name')}</label>
              <input
                className="input-field"
                value={s.name}
                onChange={(e) => updateServer(i, { name: e.target.value })}
              />
            </div>
            <div className="form-field">
              <label className="form-label">{t('settings.mcp.type')}</label>
              <select
                className="input-field"
                value={s.type}
                onChange={(e) => updateServer(i, { type: e.target.value as 'stdio' | 'sse' | 'streamable-http' })}
              >
                <option value="stdio">stdio</option>
                <option value="sse">SSE</option>
                <option value="streamable-http">Streamable HTTP</option>
              </select>
            </div>
            {s.type === 'stdio' ? (
              <>
                <div className="form-field span-2">
                  <label className="form-label">{t('settings.mcp.command')}</label>
                  <input
                    className="input-field mono"
                    value={s.command || ''}
                    onChange={(e) => updateServer(i, { command: e.target.value })}
                    placeholder="npx"
                  />
                  <p className="form-hint">{t('settings.mcp.commandHint')}</p>
                </div>
                <div className="form-field span-2">
                  <label className="form-label">{t('settings.mcp.args')}</label>
                  <input
                    className="input-field mono"
                    value={(s.args || []).join(' ')}
                    onChange={(e) => updateServer(i, { args: e.target.value.split(/\s+/).filter(Boolean) })}
                    placeholder="-y @playwright/mcp@latest"
                  />
                </div>
                <div className="form-field span-2">
                  <label className="form-label">{t('settings.mcp.env')}</label>
                  <textarea
                    className="input-field mono"
                    rows={3}
                    value={Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')}
                    onChange={(e) => {
                      const env: Record<string, string> = {}
                      for (const line of e.target.value.split('\n')) {
                        const eq = line.indexOf('=')
                        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
                      }
                      updateServer(i, { env })
                    }}
                    placeholder="KEY=value"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="form-field span-2">
                  <label className="form-label">{t('settings.mcp.url')}</label>
                  <input
                    className="input-field mono"
                    value={s.url || ''}
                    onChange={(e) => updateServer(i, { url: e.target.value })}
                    placeholder="https://mcp.example.com/sse"
                  />
                </div>
                <div className="form-field span-2">
                  <label className="form-label">{t('settings.mcp.authType')}</label>
                  <select
                    className="input-field"
                    value={s.authType || 'none'}
                    onChange={(e) => updateServer(i, { authType: e.target.value as 'none' | 'bearer' | 'apikey' | 'custom' })}
                  >
                    <option value="none">{t('settings.mcp.authNone')}</option>
                    <option value="bearer">{t('settings.mcp.authBearer')}</option>
                    <option value="apikey">{t('settings.mcp.authApiKey')}</option>
                    <option value="custom">{t('settings.mcp.authCustom')}</option>
                  </select>
                </div>
                {/* Bearer Token */}
                {s.authType === 'bearer' && (
                  <div className="form-field span-2">
                    <label className="form-label">{t('settings.mcp.authToken')}</label>
                    <input
                      className="input-field mono"
                      type="password"
                      value={s.authToken || ''}
                      onChange={(e) => updateServer(i, { authToken: e.target.value })}
                      placeholder="eyJhbGciOiJIUzI1NiIs..."
                    />
                  </div>
                )}
                {/* API Key */}
                {s.authType === 'apikey' && (
                  <>
                    <div className="form-field">
                      <label className="form-label">{t('settings.mcp.authHeader')}</label>
                      <input
                        className="input-field mono"
                        value={s.authHeader || ''}
                        onChange={(e) => updateServer(i, { authHeader: e.target.value })}
                        placeholder="X-API-Key"
                      />
                    </div>
                    <div className="form-field">
                      <label className="form-label">{t('settings.mcp.apiKey')}</label>
                      <input
                        className="input-field mono"
                        type="password"
                        value={s.apiKey || ''}
                        onChange={(e) => updateServer(i, { apiKey: e.target.value })}
                        placeholder="sk-xxx"
                      />
                    </div>
                  </>
                )}
                {/* 自定义 Headers */}
                {s.authType === 'custom' && (
                  <CustomHeadersField
                    headers={s.headers}
                    label={t('settings.mcp.customHeaders')}
                    onChange={(headers) => updateServer(i, { headers })}
                  />
                )}
              </>
            )}
          </div>
        </div>
      ))}

      <button onClick={addServer} className="btn-ghost" style={{ width: '100%', marginTop: 8 }}>
        <Plus size={14} />
        {t('settings.mcp.addServer')}
      </button>
    </div>
  )
}
