import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, CircleDot, Plus, Trash2, Loader2, RefreshCw } from 'lucide-react'
import type { ProviderConfig } from '@shared/types'
import { useProviderContextDetection } from './useProviderContextDetection'
import { TEMPERATURE_MAX, TEMPERATURE_MIN, TEMPERATURE_STEP, TemperatureInput } from './TemperatureInput'

interface Props {
  providers: ProviderConfig[]
  activeId: string | null
  onChange: (providers: ProviderConfig[], activeId: string | null) => void
}

export function ProviderSettings({ providers, activeId, onChange }: Props) {
  const { t } = useTranslation()
  const { detecting, detected, detectContextWindow } = useProviderContextDetection({ providers, activeId, onChange })
  // 模型列表状态：key = `${providerId}::${baseUrl}`（baseUrl 变了旧列表自动失效）
  const [modelLists, setModelLists] = useState<Record<string, { id: string; name?: string; ownedBy?: string }[]>>({})
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({})
  const [modelsError, setModelsError] = useState<Record<string, string>>({})
  const [openModelList, setOpenModelList] = useState<string | null>(null)

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

  const addProvider = () => {
    const id = `prov-${Date.now()}`
    const newProv: ProviderConfig = {
      id,
      name: 'New Provider',
      baseUrl: 'https://api.zhuminet.com/v1',
      apiKey: '',
      defaultModel: '',
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
                <div className="model-picker">
                  <input
                    className="input-field"
                    value={p.defaultModel}
                    placeholder={t('settings.providers.modelPlaceholder')}
                    onChange={(e) => updateProvider(i, { defaultModel: e.target.value })}
                    onFocus={() => {
                      setOpenModelList(p.id)
                      void loadModels(i, false)
                    }}
                  />
                  {openModelList === p.id && modelLists[listKey(p)]?.length > 0 && (
                    <>
                      <button className="model-list-backdrop" aria-label={t('settings.cancel')} onClick={() => setOpenModelList(null)} />
                      <div className="model-list" role="listbox">
                        {modelLists[listKey(p)].map((model) => (
                          <button
                            type="button"
                            role="option"
                            aria-selected={model.id === p.defaultModel}
                            className={model.id === p.defaultModel ? 'model-list-item active' : 'model-list-item'}
                            key={model.id}
                            onClick={() => {
                              updateProvider(i, { defaultModel: model.id })
                              setOpenModelList(null)
                              void detectContextWindow({ ...p, defaultModel: model.id })
                            }}
                          >
                            <span>{model.name || model.id}</span>
                            {model.name && <small>{model.id}</small>}
                            {model.ownedBy && <small>{model.ownedBy}</small>}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                <button
                  className="icon-button"
                  style={{ flex: 'none' }}
                  title={t('settings.providers.modelRefresh')}
                  disabled={!!modelsLoading[listKey(p)]}
                  onClick={() => {
                    setOpenModelList(p.id)
                    void loadModels(i, true)
                  }}
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
                onBlur={() => void detectContextWindow(p)}
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
                onBlur={() => {
                  const current = providers.find(provider => provider.id === p.id)
                  if (current?.apiKey) void detectContextWindow(current)
                }}
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
              min={TEMPERATURE_MIN}
              max={TEMPERATURE_MAX}
              step={TEMPERATURE_STEP}
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
                onClick={() => void detectContextWindow(p)}
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
