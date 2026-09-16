import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUp,
  BrainCircuit,
  ChevronDown,
  ImagePlus,
  Shield,
  ShieldCheck,
  ShieldOff,
  Square,
  UserRound,
  Volume2,
  VolumeX
} from 'lucide-react'

import type { AutoApproveMode } from '@shared/types'
import { MAX_IMAGES } from '../utils/image'
import { useAppStore } from '../store'
import { ttsPlayback } from '../tts/playback'
import SetupRequiredDialog from './SetupRequiredDialog'

interface Props {
  sessionId: string
  pendingImageCount: number
  canSubmit: boolean
  onAddImages: (files: File[]) => Promise<void>
  onSubmit: () => void
  onError: (error: string) => void
}

export default function ComposerToolbar({
  sessionId,
  pendingImageCount,
  canSubmit,
  onAddImages,
  onSubmit,
  onError
}: Props) {
  const { t } = useTranslation()
  const settings = useAppStore(s => s.settings)
  const selectedProviderModel = useAppStore(s => s.selectedProviderModel)
  const approveMode = useAppStore(s => s.approveMode)
  const reasoningEffort = useAppStore(s => s.reasoningEffort)
  const isRunning = useAppStore(s => s.runningIds.has(sessionId))
  const activeSession = useAppStore(s => s.sessions.find(session => session.id === sessionId))
  const setApproveMode = useAppStore(s => s.setApproveMode)
  const setSelectedProviderModel = useAppStore(s => s.setSelectedProviderModel)
  const setReasoningEffort = useAppStore(s => s.setReasoningEffort)
  const setSessionAvatar = useAppStore(s => s.setSessionAvatar)
  const setSessionTts = useAppStore(s => s.setSessionTts)
  const abortAgent = useAppStore(s => s.abortAgent)

  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [effortMenuOpen, setEffortMenuOpen] = useState(false)
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)
  const [setupPrompt, setSetupPrompt] = useState<'avatar' | 'tts' | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const enabledProviders = settings.providers.filter(provider => provider.enabled)
  const selectedProviderId = selectedProviderModel?.split('::')[0]
  const activeRunProvider = enabledProviders.find(provider => provider.id === selectedProviderId)
    || enabledProviders.find(provider => provider.id === settings.activeProviderId)
  const reasoningSupported = activeRunProvider?.reasoningEnabled === true
  const avatarModels = settings.avatarModels || []
  const activeAvatarModel = activeSession?.avatarEnabled
    ? avatarModels.find(model => model.id === activeSession.avatarModelId)
    : undefined
  const ttsReady = settings.ttsModels.some(model => model.id === settings.defaultTtsModelId)

  const modeIcon = (mode: AutoApproveMode) => {
    if (mode === 'manual') return <ShieldOff size={13} />
    if (mode === 'auto') return <Shield size={13} />
    return <ShieldCheck size={13} />
  }
  const modeLabel = (mode: AutoApproveMode) => t(`chat.approve${mode === 'manual' ? 'Manual' : mode === 'auto' ? 'Auto' : 'Full'}`)
  const modeHint = (mode: AutoApproveMode) => t(`chat.approve${mode === 'manual' ? 'Manual' : mode === 'auto' ? 'Auto' : 'Full'}Hint`)

  return (
    <div className="composer-toolbar">
      <button
        className="composer-icon-btn"
        title={t('chat.attachImage')}
        onClick={() => fileInputRef.current?.click()}
        disabled={isRunning || pendingImageCount >= MAX_IMAGES}
      >
        <ImagePlus size={17} />
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="attach-file-input"
        onChange={event => {
          if (event.target.files) void onAddImages(Array.from(event.target.files))
          event.target.value = ''
        }}
      />

      <div className="mode-selector">
        <button
          className={approveMode === 'full' ? 'composer-mode-chip mode-full' : approveMode === 'auto' ? 'composer-mode-chip mode-auto' : 'composer-mode-chip'}
          onClick={() => setModeMenuOpen(!modeMenuOpen)}
          title={modeHint(approveMode)}
        >
          {modeIcon(approveMode)}
          {modeLabel(approveMode)}
        </button>
        {modeMenuOpen && (
          <>
            <div className="mode-menu-backdrop" onClick={() => setModeMenuOpen(false)} />
            <div className="mode-menu">
              {(['manual', 'auto', 'full'] as AutoApproveMode[]).map(mode => (
                <button
                  key={mode}
                  className={mode === approveMode ? 'mode-menu-item active' : 'mode-menu-item'}
                  onClick={() => { setApproveMode(mode); setModeMenuOpen(false) }}
                  title={modeHint(mode)}
                >
                  {modeIcon(mode)}
                  <span className="mode-menu-label">
                    <strong>{modeLabel(mode)}</strong>
                    <small>{modeHint(mode)}</small>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="mode-selector">
        <button
          className={activeAvatarModel ? 'composer-mode-chip avatar-active' : 'composer-mode-chip'}
          onClick={() => avatarModels.length === 0 ? setSetupPrompt('avatar') : setAvatarMenuOpen(!avatarMenuOpen)}
          disabled={!activeSession}
          title={avatarModels.length === 0 ? t('chat.avatarNoModels') : t('chat.avatarHint')}
        >
          <UserRound size={13} />
          {activeAvatarModel?.name || t('chat.avatarOff')}
          <ChevronDown size={11} className={avatarMenuOpen ? 'chevron-up' : ''} />
        </button>
        {avatarMenuOpen && (
          <>
            <div className="mode-menu-backdrop" onClick={() => setAvatarMenuOpen(false)} />
            <div className="mode-menu avatar-menu">
              <button
                className={!activeAvatarModel ? 'mode-menu-item active' : 'mode-menu-item'}
                onClick={() => { void setSessionAvatar(null); setAvatarMenuOpen(false) }}
              >
                {t('chat.avatarOff')}
              </button>
              {avatarModels.map(model => (
                <button
                  key={model.id}
                  className={activeAvatarModel?.id === model.id ? 'mode-menu-item active' : 'mode-menu-item'}
                  onClick={() => { void setSessionAvatar(model.id); setAvatarMenuOpen(false) }}
                >
                  <UserRound size={13} />
                  {model.name}
                  {model.id === settings.defaultAvatarModelId && <small>{t('chat.avatarDefault')}</small>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <button
        className={activeSession?.ttsEnabled ? 'composer-mode-chip tts-active' : 'composer-mode-chip'}
        disabled={!activeSession}
        title={!ttsReady ? t('chat.ttsNoModel') : activeSession?.ttsEnabled ? t('chat.ttsDisable') : t('chat.ttsEnable')}
        onClick={() => {
          if (!ttsReady) {
            setSetupPrompt('tts')
            return
          }
          if (!activeSession?.ttsEnabled) void ttsPlayback.unlock().catch(error => onError(String(error)))
          void setSessionTts(!activeSession?.ttsEnabled).catch(error => onError(String(error)))
        }}
      >
        {activeSession?.ttsEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
        TTS
      </button>

      <div className="composer-toolbar-spacer" />

      {reasoningSupported && (
        <div className="mode-selector">
          <button
            className={reasoningEffort === 'high' ? 'composer-effort-chip effort-high' : reasoningEffort === 'low' ? 'composer-effort-chip effort-low' : 'composer-effort-chip'}
            onClick={() => setEffortMenuOpen(!effortMenuOpen)}
            title={t('chat.reasoningEffortHint')}
          >
            <BrainCircuit size={14} />
            {t(`chat.reasoningEffort.${reasoningEffort}`)}
          </button>
          {effortMenuOpen && (
            <>
              <div className="mode-menu-backdrop" onClick={() => setEffortMenuOpen(false)} />
              <div className="mode-menu effort-menu">
                {(['off', 'low', 'medium', 'high'] as const).map(effort => (
                  <button
                    key={effort}
                    className={effort === reasoningEffort ? 'mode-menu-item active' : 'mode-menu-item'}
                    onClick={() => { setReasoningEffort(effort); setEffortMenuOpen(false) }}
                  >
                    <span className="effort-menu-label">{t(`chat.reasoningEffort.${effort}`)}</span>
                    <small className="effort-menu-desc">{t(`chat.reasoningEffortDesc.${effort}`)}</small>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="mode-selector">
        <button
          className="composer-model-select"
          onClick={() => setModelMenuOpen(!modelMenuOpen)}
          title={t('chat.selectModelHint')}
        >
          <span className="composer-model-name">
            {selectedProviderModel
              ? `${enabledProviders.find(provider => provider.id === selectedProviderId)?.name || ''} · ${selectedProviderModel.split('::')[1]}`
              : t('chat.defaultModel')}
          </span>
          <ChevronDown size={12} className={modelMenuOpen ? 'chevron-up' : ''} />
        </button>
        {modelMenuOpen && (
          <>
            <div className="mode-menu-backdrop" onClick={() => setModelMenuOpen(false)} />
            <div className="mode-menu model-menu">
              <button
                className={selectedProviderModel === null ? 'mode-menu-item active' : 'mode-menu-item'}
                onClick={() => { setSelectedProviderModel(null); setModelMenuOpen(false) }}
              >
                {t('chat.defaultModel')}
              </button>
              {enabledProviders.map(provider => (
                <button
                  key={provider.id}
                  className={selectedProviderModel === `${provider.id}::${provider.defaultModel}` ? 'mode-menu-item active' : 'mode-menu-item'}
                  onClick={() => { setSelectedProviderModel(`${provider.id}::${provider.defaultModel}`); setModelMenuOpen(false) }}
                >
                  {provider.name} · {provider.defaultModel}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <button
        className={isRunning ? 'composer-send stop' : 'composer-send'}
        onClick={isRunning ? abortAgent : onSubmit}
        disabled={!isRunning && !canSubmit}
        title={isRunning ? t('chat.stop') : t('chat.send')}
      >
        {isRunning ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} />}
      </button>

      {setupPrompt && <SetupRequiredDialog target={setupPrompt} onClose={() => setSetupPrompt(null)} />}
    </div>
  )
}
