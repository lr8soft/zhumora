import { Film, Plus, Star, Trash2, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AvatarAnimationConfig, AvatarModelConfig } from '@shared/avatar'

interface Props {
  models: AvatarModelConfig[]
  defaultModelId: string | null
  onChange: (models: AvatarModelConfig[], defaultModelId: string | null) => void
}

export function AvatarSettings({ models, defaultModelId, onChange }: Props) {
  const { t } = useTranslation()

  const updateModel = (id: string, patch: Partial<AvatarModelConfig>) => {
    onChange(models.map(model => model.id === id ? { ...model, ...patch } : model), defaultModelId)
  }

  const importModel = async () => {
    const model = await window.api.avatar.importModel()
    if (!model) return
    onChange([...models, model], defaultModelId || model.id)
  }

  const removeModel = (id: string) => {
    const next = models.filter(model => model.id !== id)
    onChange(next, defaultModelId === id ? (next[0]?.id || null) : defaultModelId)
  }

  const addEmbeddedAnimation = (model: AvatarModelConfig) => {
    const animation: AvatarAnimationConfig = {
      id: `embedded-${crypto.randomUUID()}`,
      name: t('settings.avatar.newAnimation'),
      source: 'embedded',
      clipName: ''
    }
    updateModel(model.id, { animations: [...model.animations, animation] })
  }

  const importVrma = async (model: AvatarModelConfig) => {
    const animation = await window.api.avatar.importAnimation()
    if (!animation) return
    updateModel(model.id, { animations: [...model.animations, animation] })
  }

  const updateAnimation = (model: AvatarModelConfig, animationId: string, patch: Partial<AvatarAnimationConfig>) => {
    updateModel(model.id, {
      animations: model.animations.map(animation =>
        animation.id === animationId ? { ...animation, ...patch } : animation)
    })
  }

  const removeAnimation = (model: AvatarModelConfig, animationId: string) => {
    updateModel(model.id, { animations: model.animations.filter(animation => animation.id !== animationId) })
  }

  return (
    <div>
      <div className="settings-section">
        <div className="settings-section-title">
          <UserRound size={17} />
          <div>
            <h3>{t('settings.avatar.library')}</h3>
            <p>{t('settings.avatar.hint')}</p>
          </div>
        </div>
        <button className="btn-primary" onClick={() => void importModel()}>
          <Plus size={14} />
          {t('settings.avatar.importModel')}
        </button>
      </div>

      {models.length === 0 && <div className="memory-empty">{t('settings.avatar.empty')}</div>}

      {models.map(model => (
        <div className={model.id === defaultModelId ? 'avatar-model-card default' : 'avatar-model-card'} key={model.id}>
          <div className="avatar-model-head">
            <UserRound size={17} />
            <div className="form-field avatar-model-name">
              <label className="form-label">{t('settings.avatar.modelName')}</label>
              <input
                className="input-field"
                value={model.name}
                onChange={event => updateModel(model.id, { name: event.target.value })}
              />
            </div>
            <button
              className={model.id === defaultModelId ? 'btn-ghost btn-sm avatar-default active' : 'btn-ghost btn-sm avatar-default'}
              onClick={() => onChange(models, model.id)}
            >
              <Star size={13} fill={model.id === defaultModelId ? 'currentColor' : 'none'} />
              {t('settings.avatar.default')}
            </button>
            <button className="danger-link" onClick={() => removeModel(model.id)}>
              <Trash2 size={13} />
            </button>
          </div>
          <p className="avatar-asset-path" title={model.filePath}>{model.filePath}</p>

          <div className="avatar-animation-head">
            <div>
              <strong>{t('settings.avatar.animations')}</strong>
              <p className="form-hint">{t('settings.avatar.animationsHint')}</p>
            </div>
            <div className="avatar-animation-actions">
              <button className="btn-ghost btn-sm" onClick={() => addEmbeddedAnimation(model)}>
                <Plus size={12} />{t('settings.avatar.addEmbedded')}
              </button>
              <button className="btn-ghost btn-sm" onClick={() => void importVrma(model)}>
                <Film size={12} />{t('settings.avatar.importVrma')}
              </button>
            </div>
          </div>

          {model.animations.map(animation => (
            <div className="avatar-animation-row" key={animation.id}>
              <span className="avatar-animation-source">{animation.source === 'vrma' ? 'VRMA' : t('settings.avatar.embedded')}</span>
              <input
                className="input-field"
                value={animation.name}
                placeholder={t('settings.avatar.animationName')}
                onChange={event => updateAnimation(model, animation.id, { name: event.target.value })}
              />
              {animation.source === 'embedded' ? (
                <input
                  className="input-field mono"
                  value={animation.clipName || ''}
                  placeholder={t('settings.avatar.clipName')}
                  onChange={event => updateAnimation(model, animation.id, { clipName: event.target.value })}
                />
              ) : (
                <span className="avatar-animation-file" title={animation.filePath}>{animation.filePath}</span>
              )}
              <button className="danger-link" onClick={() => removeAnimation(model, animation.id)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
