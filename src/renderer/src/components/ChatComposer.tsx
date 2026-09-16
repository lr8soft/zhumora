import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

import { processImageFile, ImageAttachmentError, MAX_IMAGES } from '../utils/image'
import { useAppStore } from '../store'
import { ttsPlayback } from '../tts/playback'
import ComposerToolbar from './ComposerToolbar'

interface Props {
  sessionId: string
}

/**
 * 高频输入边界。草稿和附件只在此组件内更新，避免每次按键都让长消息列表
 * 参与 React reconciliation。持久化消息仍由 store action/main 负责。
 */
function ChatComposer({ sessionId }: Props) {
  const { t } = useTranslation()
  const isRunning = useAppStore(s => s.runningIds.has(sessionId))
  const activeSession = useAppStore(s => s.sessions.find(session => session.id === sessionId))
  const ttsError = useAppStore(s => s.ttsErrors[sessionId])
  const inputAreaHeight = useAppStore(s => s.inputAreaHeight)
  const setInputAreaHeight = useAppStore(s => s.setInputAreaHeight)
  const sendMessage = useAppStore(s => s.sendMessage)

  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const inputAreaRef = useRef<HTMLDivElement>(null)

  // 未发送附件属于其创建时的会话；切换会话时不能带到另一会话。
  useEffect(() => {
    setPendingImages([])
    setImageError(null)
  }, [sessionId])

  const handleSubmit = () => {
    const text = input.trim()
    if ((!text && pendingImages.length === 0) || isRunning) return
    if (activeSession?.ttsEnabled) {
      void ttsPlayback.unlock().catch(error => setImageError(String(error)))
    }
    void sendMessage(text, pendingImages.length > 0 ? [...pendingImages] : undefined)
    setInput('')
    setPendingImages([])
    setImageError(null)
  }

  /** 粘贴、拖放和文件选择的统一图片入口。 */
  const addImages = async (files: File[]) => {
    if (isRunning) return
    const room = MAX_IMAGES - pendingImages.length
    if (room <= 0) {
      setImageError(t('chat.imageLimit', { max: MAX_IMAGES }))
      return
    }
    setImageError(null)
    const processed: string[] = []
    for (const file of files.slice(0, room)) {
      try {
        processed.push(await processImageFile(file))
      } catch (err) {
        const code = err instanceof ImageAttachmentError ? err.code : 'decode-failed'
        const errorKey = {
          'unsupported-type': 'chat.imageErrorUnsupported',
          'too-large': 'chat.imageErrorTooLarge',
          'decode-failed': 'chat.imageErrorDecode'
        }[code]
        setImageError(t(errorKey))
        break
      }
    }
    if (processed.length > 0) setPendingImages(prev => [...prev, ...processed])
  }

  /** 拖拽输入区上缘调整高度；单击手柄恢复内容自适应。 */
  const onInputResizeStart = (event: React.MouseEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startArea = inputAreaRef.current?.getBoundingClientRect().height ?? 0
    let moved = false
    const onMove = (moveEvent: MouseEvent) => {
      const delta = startY - moveEvent.clientY
      if (Math.abs(delta) >= 4) moved = true
      if (moved) setInputAreaHeight(startArea + delta)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (!moved) setInputAreaHeight(0)
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const handlePaste = (event: React.ClipboardEvent) => {
    if (isRunning) return
    const files = Array.from(event.clipboardData.items)
      .filter(item => item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length > 0) {
      event.preventDefault()
      void addImages(files)
    }
  }

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    if (!isRunning && event.dataTransfer.files.length > 0) {
      void addImages(Array.from(event.dataTransfer.files))
    }
  }

  return (
    <div
      ref={inputAreaRef}
      className={inputAreaHeight > 0 ? 'chat-input-area fixed-height' : 'chat-input-area'}
      style={inputAreaHeight > 0 ? { height: `${inputAreaHeight}px` } : undefined}
    >
      <div
        className="chat-input-resizer"
        onMouseDown={onInputResizeStart}
        title={t('chat.inputResizeHint')}
      />
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
            if (event.key === 'Enter' && !event.shiftKey) {
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
