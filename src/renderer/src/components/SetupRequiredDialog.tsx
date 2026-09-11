import { UserRound, Volume2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store'

interface Props {
  target: 'avatar' | 'tts'
  onClose: () => void
}

export default function SetupRequiredDialog({ target, onClose }: Props) {
  const { t } = useTranslation()
  const openSettings = () => {
    const store = useAppStore.getState()
    store.setSettingsTab(target)
    store.setView('settings')
    onClose()
  }

  return (
    <div className="dialog-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="setup-required-title">
        <div className="dialog-header">
          <div>
            <span className="dialog-title-icon" style={{ color: 'var(--app-color-primary-strong)', background: 'color-mix(in srgb, var(--app-color-primary-strong) 12%, transparent)' }}>
              {target === 'avatar' ? <UserRound size={17} /> : <Volume2 size={17} />}
            </span>
            <h2 id="setup-required-title">{t(`settings.tabs.${target}`)}</h2>
          </div>
        </div>
        <div className="dialog-body">
          <p className="dialog-confirm-text">{t(target === 'avatar' ? 'chat.avatarNoModels' : 'chat.ttsNoModel')}</p>
        </div>
        <div className="dialog-footer">
          <button className="btn-ghost" onClick={onClose}>{t('settings.cancel')}</button>
          <button className="btn-primary" onClick={openSettings}>{t('sidebar.settings')}</button>
        </div>
      </div>
    </div>
  )
}
