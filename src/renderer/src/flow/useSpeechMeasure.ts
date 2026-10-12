import { useEffect, useLayoutEffect, useState } from 'react'

export interface SpeechMeasure {
  onMount?: (id: string, mounted: boolean) => void
  onMeasure?: (id: string, width: number, height: number) => void
}

export function useSpeechMeasure(id: string, content: string, layout: string, callbacks: SpeechMeasure) {
  const [card, setCard] = useState<HTMLDivElement | null>(null)
  const { onMount, onMeasure } = callbacks
  useLayoutEffect(() => {
    if (card) onMeasure?.(id, card.offsetWidth, card.offsetHeight)
  }, [card, id, content, layout, onMeasure])
  useEffect(() => {
    const owner = card?.ownerDocument.defaultView
    if (!card || !owner) return
    onMount?.(id, true)
    const observer = new owner.ResizeObserver(() => onMeasure?.(id, card.offsetWidth, card.offsetHeight))
    observer.observe(card)
    return () => { observer.disconnect(); onMount?.(id, false) }
  }, [card, id, onMount, onMeasure])
  return setCard
}
