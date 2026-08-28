import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, CircleDot, Plus, Trash2, Loader2, RefreshCw } from 'lucide-react'
import type { ProviderConfig } from '@shared/types'

interface Props {
  providers: ProviderConfig[]
  activeId: string | null
  onChange: (providers: ProviderConfig[], activeId: string | null) => void
}

export function ProviderSettings({ providers, activeId, onChange }: Props) {
  const { t } = useTranslation()
  // 上下文窗口探测状态（按 provider id）：填/改 Base URL 时自动识别
  const [detecting, setDetecting] = useState<Record<string, boolean>>({})
  const [detected, setDetected] = useState<Record<string, number>>({})

  /** 探测上下文窗口（手动配置优先；否则 API 探测 → 启发式 → 默认值） */
  const detectContextWindow = async (idx: number) => {
    const p = providers[idx]
    if (!p?.baseUrl || detecting[p.id]) return
    setDetecting((s) => ({ ...s, [p.id]: true }))
    try {
      const res = await window.api.provider.detectContextWindow(p, p.defaultModel)
      if (typeof res.detected === 'number') {
        setDetected((s) => ({ ...s, [p.id]: res.detected! }))
        // 用户未手动填写（0）→ 把探测值回填到输入框，让限制真实生效
        if (!p.contextWindow || p.contextWindow <= 0) {
          updateProvider(idx, { contextWindow: res.detected })
        }
      }
    } catch {
      // 探测失败：保持 0（自动），不阻塞用户
    } finally {
      setDetecting((s) => {
        const next = { ...s }
        delete next[p.id]
        return next
      })
    }
  }
  const addProvider = () => {
    const id = `prov-${Date.now()}`
    const newProv: ProviderConfig = {
      id,
      name: 'New Provider',
      baseUrl: 'https://api.zhuminet.com/v1',
      apiKey: '',
      defaultModel: 'gemma-4-26B-A4B-it-262K',
      enabled: true,
      temperature: undefined,
      reasoningEnabled: false,
      reasoningEffort: 'medium',
      contextWindow: 0
    }
    onChange([...providers, newProv], activeId || id)
  }

  const updateProvider = (idx: number, updates: Partial<ProviderConfig>) => {
    const next = [...providers]
    next[idx] = { ...next[idx], ...updates }
    onChange(next, activeId)
  }

  const removeProvider = (idx: number) => {
    const next = providers.filter((_, i) => i !== idx)
    const newActiveId = providers[idx].id === activeId
      ? (next[0]?.id || null)
      : activeId
    onChange(next, newActiveId)
  }

  return (
    <div>
      <p className="form-hint" style={{ marginBottom: 14 }}>{t('settings.providers.hint')}</p>

      {/* 煮米 API 引流 */}
      <div className="promo-banner">
        <span><strong>煮米 API</strong> — {t('settings.providers.zhuminetBanner')}</span>
        <button
          onClick={() => window.api.settings.openExternal('https://api.zhuminet.com/')}
          className="link-button"
        >
          {t('settings.providers.zhuminetRegister')}
        </button>
      </div>

      {providers.map((p, i) => (
        <div key={p.id} className={activeId === p.id ? 'provider-card active' : 'provider-card'}>
          <div className="provider-card-head">
            <button
              className="provider-name-button"
              onClick={() => onChange(providers, p.id)}
              title={activeId === p.id ? t('settings.providers.active') : t('settings.providers.activate')}
            >
              {activeId === p.id ? <CircleDot size={14} /> : <Circle size={14} />}
              {p.name}
            </button>
            <button onClick={() => removeProvider(i)} className="danger-link">
              <Trash2 size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              {t('settings.providers.remove')}
            </button>
          </div>
          <div className="provider-fields">
            <div className="form-field">
              <label className="form-label">{t('settings.providers.name')}</label>
              <input
                className="input-field"
                value={p.name}
                onChange={(e) => updateProvider(i, { name: e.target.value })}
              />
            </div>
            <div className="form-field">
              <label className="form-label">{t('settings.providers.defaultModel')}</label>
              <input
                className="input-field"
                value={p.defaultModel}
                onChange={(e) => updateProvider(i, { defaultModel: e.target.value })}
              />
            </div>
            <div className="form-field span-2">
              <label className="form-label">{t('settings.providers.baseUrl')}</label>
              <input
                className="input-field mono"
                value={p.baseUrl}
                onChange={(e) => updateProvider(i, { baseUrl: e.target.value })}
                onBlur={() => void detectContextWindow(i)}
              />
            </div>
            <div className="form-field span-2">
              <label className="form-label">{t('settings.providers.apiKey')}</label>
              <input
                className="input-field mono"
                type="password"
                value={p.apiKey || ''}
                placeholder={t('settings.providers.apiKeyPlaceholder')}
                onChange={(e) => updateProvider(i, { apiKey: e.target.value })}
              />
            </div>
            <div className="form-field span-2">
              <div className="switch-row">
                <div>
                  <strong>{t('settings.providers.enabled')}</strong>
                </div>
                <input
                  type="checkbox"
                  className="switch"
                  checked={p.enabled}
                  onChange={(e) => updateProvider(i, { enabled: e.target.checked })}
                />
              </div>
            </div>
          </div>

          {/* Temperature */}
          <div className="provider-row" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center' }}>
            <label className="form-label">{t('settings.providers.temperature')}{p.temperature !== undefined && ` (${p.temperature})`}</label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={p.temperature ?? 1}
              onChange={(e) => updateProvider(i, { temperature: parseFloat(e.target.value) })}
              className="range-input"
            />
            <button
              onClick={() => updateProvider(i, { temperature: undefined })}
              className="link-button"
            >
              {t('settings.providers.temperatureReset')}
            </button>
          </div>
          <p className="form-hint" style={{ marginTop: 4 }}>{t('settings.providers.temperatureHint')}</p>

          {/* Reasoning Effort */}
          <div className="provider-row">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                className="checkbox"
                checked={p.reasoningEnabled || false}
                onChange={(e) => updateProvider(i, { reasoningEnabled: e.target.checked })}
              />
              <span className="form-label">{t('settings.providers.reasoningEffort')}</span>
            </label>
            {p.reasoningEnabled && (
              <select
                className="input-field"
                style={{ width: 220 }}
                value={p.reasoningEffort || 'medium'}
                onChange={(e) => updateProvider(i, { reasoningEffort: e.target.value as 'low' | 'medium' | 'high' })}
              >
                <option value="low">{t('settings.providers.reasoningLow')}</option>
                <option value="medium">{t('settings.providers.reasoningMedium')}</option>
                <option value="high">{t('settings.providers.reasoningHigh')}</option>
              </select>
            )}
          </div>

          {/* Context Window */}
          <div className="provider-row" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center' }}>
            <label className="form-label">{t('settings.providers.contextWindow')}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                className="input-field"
                value={p.contextWindow || 0}
                min={0}
                step={1024}
                onChange={(e) => updateProvider(i, { contextWindow: parseInt(e.target.value) || 0 })}
                placeholder="0"
              />
              {detected[p.id] > 0 && (
                <span className="form-hint" style={{ whiteSpace: 'nowrap' }}>
                  {t('settings.providers.contextWindowDetected')}: {detected[p.id].toLocaleString()}
                </span>
              )}
              {detecting[p.id] && <Loader2 size={13} className="spin" />}
              <button
                onClick={() => void detectContextWindow(i)}
                className="link-button"
                title={t('settings.providers.contextWindowDetect')}
              >
                <RefreshCw size={12} style={{ verticalAlign: -1, marginRight: 3 }} />
                {t('settings.providers.contextWindowAuto')}
              </button>
            </div>
          </div>
          <p className="form-hint" style={{ marginTop: 4 }}>{t('settings.providers.contextWindowHint')}</p>
        </div>
      ))}

      <button onClick={addProvider} className="btn-ghost" style={{ width: '100%', marginTop: 8 }}>
        <Plus size={14} />
        {t('settings.providers.addProvider')}
      </button>
    </div>
  )
}