import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
import type { ProviderConfig } from '@shared/types'
import { providerRequestIdentity } from '@shared/providerHeaders'

export function ProviderModelPicker({ provider: p, onChange, detectContextWindow }: {
  provider: ProviderConfig
  onChange: (value: Partial<ProviderConfig>) => void
  detectContextWindow: (provider: ProviderConfig) => Promise<void>
}) {
  const { t } = useTranslation()
  // 视图实例缓存：providerId + 有效请求配置，配置变化失效，卸载时释放。
  const [modelLists, setModelLists] = useState<Record<string, { id: string; name?: string; ownedBy?: string }[]>>({})
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({})
  const [modelsError, setModelsError] = useState<Record<string, string>>({})
  const [openModelList, setOpenModelList] = useState<string | null>(null)

  const listKey = (p: ProviderConfig) => `${p.id}::${providerRequestIdentity(p)}`

  /** 拉取模型列表（聚焦时懒加载；刷新按钮 force 强拉） */
  const loadModels = async (force: boolean) => {
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

  return (
            <div className="form-field">
              <label className="form-label" htmlFor={`provider-model-${p.id}`}>{t('settings.providers.defaultModel')}</label>
              <div className="model-combobox">
                <div className="model-picker">
                  <input
                    className="input-field"
                    id={`provider-model-${p.id}`}
                    value={p.defaultModel}
                    placeholder={t('settings.providers.modelPlaceholder')}
                    onChange={(e) => onChange({ defaultModel: e.target.value })}
                    onFocus={() => {
                      setOpenModelList(p.id)
                      void loadModels(false)
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
                              onChange({ defaultModel: model.id })
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
                    void loadModels(true)
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
  )
}
