import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, CircleDot, Plus, Trash2, Loader2, RefreshCw } from 'lucide-react'
import type { ProviderConfig } from '@shared/types'

interface Props {
  providers: ProviderConfig[]
  activeId: string | null
  onChange: (providers: ProviderConfig[], activeId: string | null) => void
}

const TEMP_MIN = 0
const TEMP_MAX = 2
const TEMP_STEP = 0.01

/** 四舍五入到 0.01，消除浮点误差 */
const roundTemp = (v: number) => Math.round(v * 100) / 100
const clampTemp = (v: number) => Math.min(TEMP_MAX, Math.max(TEMP_MIN, roundTemp(v)))

/**
 * 温度数字输入框。
 * 输入过程中不拦截用户输入（可以临时超出范围），只在失焦时收敛到 [min, max]。
 * 未聚焦时跟随外部值，保证拖动滑杆 / 重置后数字同步。
 */
function TemperatureInput({
  value,
  disabled,
  onCommit
}: {
  value: number
  disabled?: boolean
  onCommit: (v: number) => void
}) {
  const [focused, setFocused] = useState(false)
  const [text, setText] = useState('')

  const display = focused ? text : String(roundTemp(value))

  return (
    <input
      type="number"
      className="input-field temp-number"
      min={TEMP_MIN}
      max={TEMP_MAX}
      step={TEMP_STEP}
      value={display}
      disabled={disabled}
      onFocus={() => {
        setFocused(true)
        setText(String(roundTemp(value)))
      }}
      onChange={(e) => {
        setText(e.target.value)
        const v = parseFloat(e.target.value)
        // 输入中：只做有效性校验，不夹范围，让用户能打 "1" → "0.75"
        if (Number.isFinite(v)) onCommit(roundTemp(v))
      }}
      onBlur={() => {
        setFocused(false)
        const v = parseFloat(text)
        onCommit(Number.isFinite(v) ? clampTemp(v) : roundTemp(value))
      }}
    />
  )
}

export function ProviderSettings({ providers, activeId, onChange }: Props) {
  const { t } = useTranslation()
  // 上下文窗口探测状态（按 provider id）：填/改 Base URL 时自动识别
  const [detecting, setDetecting] = useState<Record<string, boolean>>({})
  const [detected, setDetected] = useState<Record<string, number>>({})
  // 模型列表状态：key = `${providerId}::${baseUrl}`（baseUrl 变了旧列表自动失效）
  const [modelLists, setModelLists] = useState<Record<string, { id: string; name?: string; ownedBy?: string }[]>>({})
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({})
  const [modelsError, setModelsError] = useState<Record<string, string>>({})

  const listKey = (p: { id: string; baseUrl: string }) => `${p.id}::${p.baseUrl}`

  /** 拉取模型列表（聚焦时懒加载；刷新按钮 force 强拉） */
  const loadModels = async (idx: number, force: boolean) => {
    const p = providers[idx]
    const key = listKey(p)
    if (!p?.baseUrl || modelsLoading[key]) return
    if (!force && modelLists[key]) return
    setModelsLoading((s) => ({ ...s, [key]: true }))
    try {
      const res = await window.api.provider.listModels(p, force)
      if (res.models && res.models.length > 0) {
        setModelLists((s) => ({ ...s, [key]: res.models }))
        setModelsError((s) => {
          const n = { ...s }
          delete n[key]
          return n
        })
      } else if (res.error) {
        setModelsError((s) => ({ ...s, [key]: res.error! }))
      }
    } catch (err) {
      setModelsError((s) => ({ ...s, [key]: (err as Error).message }))
    } finally {
      setModelsLoading((s) => {
        const n = { ...s }
        delete n[key]
        return n
      })
    }
  }

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
              <div className="model-combobox">
                <input
                  className="input-field"
                  value={p.defaultModel}
                  list={`model-datalist-${p.id}`}
                  placeholder={t('settings.providers.modelPlaceholder')}
                  onChange={(e) => updateProvider(i, { defaultModel: e.target.value })}
                  onFocus={() => void loadModels(i, false)}
                />
                {/* 原生 combobox：可下拉选择，也可自由输入不在列表中的模型 id */}
                <datalist id={`model-datalist-${p.id}`}>
                  {(modelLists[listKey(p)] || []).map((m) => (
                    <option key={m.id} value={m.id} label={m.ownedBy ? `${m.id} (${m.ownedBy})` : m.id} />
                  ))}
                </datalist>
                <button
                  className="icon-button"
                  style={{ flex: 'none' }}
                  title={t('settings.providers.modelRefresh')}
                  disabled={!!modelsLoading[listKey(p)]}
                  onClick={() => void loadModels(i, true)}
                >
                  {modelsLoading[listKey(p)]
                    ? <Loader2 size={14} className="spin" />
                    : <RefreshCw size={14} />}
                </button>
              </div>
              {modelsError[listKey(p)] && (
                <p className="form-hint" style={{ color: 'var(--app-color-danger)' }}>
                  {t('settings.providers.modelLoadFailed')}: {modelsError[listKey(p)]}
                </p>
              )}
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
          <div className="provider-row" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', alignItems: 'center' }}>
            <label className="form-label">{t('settings.providers.temperature')}{p.temperature === undefined && ` (${t('settings.providers.temperatureDefault')})`}</label>
            <input
              type="range"
              min={TEMP_MIN}
              max={TEMP_MAX}
              step={TEMP_STEP}
              value={p.temperature ?? 1}
              onChange={(e) => updateProvider(i, { temperature: parseFloat(e.target.value) })}
              className="range-input"
            />
            <TemperatureInput
              value={p.temperature ?? 1}
              disabled={p.temperature === undefined}
              onCommit={(v) => updateProvider(i, { temperature: v })}
            />
            <button
              onClick={() => updateProvider(i, { temperature: undefined })}
              className="link-button"
            >
              {t('settings.providers.temperatureReset')}
            </button>
          </div>
          <p className="form-hint" style={{ marginTop: 4 }}>{t('settings.providers.temperatureHint')}</p>

          {/* 思考强度功能开关（具体强度在聊天输入框里按会话选择） */}
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
            <p className="form-hint" style={{ marginTop: 4 }}>{t('settings.providers.reasoningEnabledHint')}</p>
          </div>

          {/* Context Window */}
          <div className="provider-row" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center' }}>
            <label className="form-label">{t('settings.providers.contextWindow')}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <input
                type="number"
                className="input-field"
                style={{ flex: 1, minWidth: 0, width: 'auto' }}
                value={p.contextWindow || 0}
                min={0}
                step={1024}
                onChange={(e) => updateProvider(i, { contextWindow: parseInt(e.target.value) || 0 })}
                placeholder="0"
              />
              {detected[p.id] > 0 && (
                <span className="form-hint" style={{ whiteSpace: 'nowrap', flex: 'none' }}>
                  {t('settings.providers.contextWindowDetected')}: {detected[p.id].toLocaleString()}
                </span>
              )}
              {detecting[p.id] && <Loader2 size={13} className="spin" style={{ flex: 'none' }} />}
              <button
                onClick={() => void detectContextWindow(i)}
                className="link-button"
                title={t('settings.providers.contextWindowDetect')}
                style={{ whiteSpace: 'nowrap', flex: 'none' }}
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