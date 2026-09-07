import { useTranslation } from 'react-i18next'
import { AVATAR_WINDOW_LIMITS, DEFAULT_AVATAR_WINDOW_SIZE, normalizeAvatarWindowSize, type AvatarWindowSize } from '@shared/avatarWindow'

export function AvatarWindowSettings({ size, onChange }: {
  size: AvatarWindowSize
  onChange: (size: AvatarWindowSize) => void
}) {
  const { t } = useTranslation()
  return <div className="settings-section">
    <h3>{t('settings.avatar.windowSize')}</h3>
    <p className="form-hint">{t('settings.avatar.windowSizeHint')}</p>
    <div className="avatar-window-size-fields">
      <label className="form-field">
        <span className="form-label">{t('settings.avatar.windowWidth')}</span>
        <input className="input-field" type="number" min={AVATAR_WINDOW_LIMITS.minWidth} max={AVATAR_WINDOW_LIMITS.maxWidth}
          value={size.width || ''} onChange={event => onChange({ ...size, width: Number(event.target.value) })}
          onBlur={() => onChange(normalizeAvatarWindowSize(size))} />
      </label>
      <label className="form-field">
        <span className="form-label">{t('settings.avatar.windowHeight')}</span>
        <input className="input-field" type="number" min={AVATAR_WINDOW_LIMITS.minHeight} max={AVATAR_WINDOW_LIMITS.maxHeight}
          value={size.height || ''} onChange={event => onChange({ ...size, height: Number(event.target.value) })}
          onBlur={() => onChange(normalizeAvatarWindowSize(size))} />
      </label>
      <button className="btn-ghost btn-sm" onClick={() => onChange({ ...DEFAULT_AVATAR_WINDOW_SIZE })}>
        {t('settings.avatar.windowReset')}
      </button>
    </div>
  </div>
}
