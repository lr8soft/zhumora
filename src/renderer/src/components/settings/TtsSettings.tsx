import { Plus, Star, Trash2, Volume2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TtsModelConfig } from '@shared/tts'

interface Props {
  models: TtsModelConfig[]
  defaultModelId: string | null
  onChange: (models: TtsModelConfig[], defaultModelId: string | null) => void
}

export function TtsSettings({ models, defaultModelId, onChange }: Props) {
  const { t } = useTranslation()
  const [error, setError] = useState('')
  const update = (id: string, patch: Partial<TtsModelConfig>) =>
    onChange(models.map(model => model.id === id ? { ...model, ...patch } : model), defaultModelId)

  const importModel = async () => {
    setError('')
    try {
      const model = await window.api.tts.importModel()
      if (model) onChange([...models, model], defaultModelId || model.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const remove = (id: string) => {
    const next = models.filter(model => model.id !== id)
    onChange(next, defaultModelId === id ? next[0]?.id || null : defaultModelId)
  }

  return <div>
    <div className="settings-section">
      <div className="settings-section-title">
        <Volume2 size={17} />
        <div><h3>{t('settings.tts.library')}</h3><p>{t('settings.tts.hint')}</p></div>
      </div>
      <button className="btn-primary" onClick={() => void importModel()}><Plus size={14} />{t('settings.tts.importModel')}</button>
    </div>
    {error && <p className="chat-image-error">{error}</p>}
    {models.length === 0 && <div className="memory-empty">{t('settings.tts.empty')}</div>}
    {models.map(model => <div className={model.id === defaultModelId ? 'tts-model-card default' : 'tts-model-card'} key={model.id}>
      <div className="avatar-model-head">
        <Volume2 size={17} />
        <div className="form-field avatar-model-name">
          <label className="form-label">{t('settings.tts.modelName')}</label>
          <input className="input-field" value={model.name} onChange={event => update(model.id, { name: event.target.value })} />
        </div>
        <span className="avatar-animation-source">{model.type.toUpperCase()}</span>
        <button className={model.id === defaultModelId ? 'btn-ghost btn-sm avatar-default active' : 'btn-ghost btn-sm avatar-default'} onClick={() => onChange(models, model.id)}>
          <Star size={13} fill={model.id === defaultModelId ? 'currentColor' : 'none'} />{t('settings.tts.default')}
        </button>
        <button className="danger-link" onClick={() => remove(model.id)}><Trash2 size={13} /></button>
      </div>
      <p className="avatar-asset-path" title={model.directory}>{model.directory}</p>
      <div className="tts-model-options">
        <div className="form-field">
          <label className="form-label">{t('settings.tts.speakerId')}</label>
          <input className="input-field" type="number" min={0} step={1} value={model.speakerId} onChange={event => update(model.id, { speakerId: Math.max(0, Math.round(Number(event.target.value) || 0)) })} />
        </div>
        <div className="form-field">
          <label className="form-label">{t('settings.tts.speed')}</label>
          <input className="input-field" type="number" min={0.5} max={2} step={0.05} value={model.speed} onChange={event => update(model.id, { speed: Math.min(2, Math.max(0.5, Number(event.target.value) || 1)) })} />
        </div>
      </div>
      <p className="form-hint">{t('settings.tts.modelLicense')}</p>
    </div>)}
  </div>
}
