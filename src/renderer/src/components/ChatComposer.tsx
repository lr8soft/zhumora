import React from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

import { useAppStore } from '../store'
import { ttsPlayback } from '../tts/playback'
import ComposerToolbar from './ComposerToolbar'
import { useComposerDraft } from './ComposerDraftProvider'
import { useComposerImages } from './useComposerImages'

interface Props {
  sessionId: string
}

/**
 * 高频输入边界。草稿 owner 在停靠/portal 外，输入只更新该 context 的消费者。
 * 移动面板不丢附件/草稿；持久化消息仍由 store action/main 负责。
 */
function ChatComposer({ sessionId }: Props) {
  const { t } = useTranslation()
  const activeSession = useAppStore(s => s.sessions.find(session => session.id === sessionId))
  const ttsError = useAppStore(s => s.ttsErrors[sessionId])
  const sendMessage = useAppStore(s => s.sendMessage)

  const { draft, setDraft } = useComposerDraft()
  const { addImages, handlePaste, handleDrop } = useComposerImages(sessionId)
  const { input, images: pendingImages, error: imageError } = draft
  const setInput = (value: string) => setDraft(previous => ({ ...previous, input: value }))
  const setImageError = (value: string | null) => setDraft(previous => ({ ...previous, error: value }))
  const setPendingImages = (update: string[] | ((images: string[]) => string[])) => setDraft(previous => ({ ...previous,
    images: typeof update === 'function' ? update(previous.images) : update }))

  const handleSubmit = () => {
    const text = input.trim()
    const current = useAppStore.getState()
    const parent = current.sessions.find(session => session.id === sessionId)?.subagent?.parentSessionId
    if ((!text && pendingImages.length === 0) || current.activeSessionId !== sessionId || current.runningIds.has(sessionId)
      || (parent && current.runningIds.has(parent))) return
    if (activeSession?.ttsEnabled) {
      void ttsPlayback.unlock().catch(error => setImageError(String(error)))
    }
    void sendMessage(text, pendingImages.length > 0 ? [...pendingImages] : undefined)
    setInput('')
    setPendingImages([])
    setImageError(null)
  }

  return (
    <div className="chat-input-area docked-composer" onClickCapture={event => {
      if (useAppStore.getState().activeSessionId !== sessionId) { event.preventDefault(); event.stopPropagation() }
    }}>
      <div className="composer" onDrop={handleDrop} onDragOver={event => event.preventDefault()}>
        {pendingImages.length > 0 && (
          <div className="chat-image-previews">
            {pendingImages.map((src, index) => (
              <span key={index} className="chat-image-preview">
                <img src={src} alt="" />
                <button
                  className="chat-image-remove"
                  title={t('chat.removeImage')}
                  onClick={() => setPendingImages(prev => prev.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        {imageError && <p className="chat-image-error">{imageError}</p>}
        {ttsError && <p className="chat-image-error">{t('chat.ttsError')}: {ttsError}</p>}

        <textarea
          value={input}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              handleSubmit()
            }
          }}
          onPaste={handlePaste}
          placeholder={t('chat.inputPlaceholder')}
          className="chat-textarea"
          rows={1}
        />

        <ComposerToolbar
          sessionId={sessionId}
          pendingImageCount={pendingImages.length}
          canSubmit={!!input.trim() || pendingImages.length > 0}
          onAddImages={addImages}
          onSubmit={handleSubmit}
          onError={error => setImageError(error)}
        />
      </div>
    </div>
  )
}

export default React.memo(ChatComposer)
