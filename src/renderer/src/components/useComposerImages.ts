import type React from 'react'
import { useTranslation } from 'react-i18next'
import { processImageFile, ImageAttachmentError, MAX_IMAGES } from '../utils/image'
import { useAppStore } from '../store'
import { useComposerDraft } from './ComposerDraftProvider'

/** Image processing updates the session draft owner, so in-flight files survive panel relocation. */
export function useComposerImages(sessionId: string) {
  const { t } = useTranslation()
  const { draft, setDraft } = useComposerDraft()
  const error = (text: string | null) => setDraft(previous => ({ ...previous, error: text }))
  const addImages = async (files: File[]) => {
    const current = useAppStore.getState()
    if (current.activeSessionId !== sessionId || current.runningIds.has(sessionId)) return
    const room = MAX_IMAGES - draft.images.length
    if (room <= 0) { error(t('chat.imageLimit', { max: MAX_IMAGES })); return }
    error(null)
    const processed: string[] = []
    for (const file of files.slice(0, room)) {
      try { processed.push(await processImageFile(file)) }
      catch (failure) {
        const code = failure instanceof ImageAttachmentError ? failure.code : 'decode-failed'
        error(t({ 'unsupported-type': 'chat.imageErrorUnsupported', 'too-large': 'chat.imageErrorTooLarge',
          'decode-failed': 'chat.imageErrorDecode' }[code]))
        break
      }
    }
    if (processed.length) setDraft(previous => ({ ...previous, images: [...previous.images, ...processed].slice(0, MAX_IMAGES) }))
  }
  const handlePaste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData.items).filter(item => item.type.startsWith('image/'))
      .map(item => item.getAsFile()).filter((file): file is File => file !== null)
    if (files.length) { event.preventDefault(); void addImages(files) }
  }
  const handleDrop = (event: React.DragEvent) => { event.preventDefault(); void addImages(Array.from(event.dataTransfer.files)) }
  return { addImages, handlePaste, handleDrop }
}
