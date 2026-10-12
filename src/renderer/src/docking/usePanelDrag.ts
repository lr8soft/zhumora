import { useEffect, useState, type MouseEvent, type RefObject } from 'react'
import type { PanelId } from '../../../shared/panels'
import { constrainPanel, dockTargetAt, type DockSide, type PanelBounds } from './layout'

interface Drag { id: PanelId; startX: number; startY: number; original: PanelBounds; resize: boolean; moved: boolean; bounds: PanelBounds; target: DockSide | null }

export function usePanelDrag(host: RefObject<HTMLDivElement | null>, finish: (id: PanelId, bounds: PanelBounds, target: DockSide | null) => void) {
  const [drag, setDrag] = useState<Drag | null>(null)
  useEffect(() => {
    if (!drag) return
    const move = (event: globalThis.MouseEvent) => {
      const rect = host.current?.getBoundingClientRect()
      if (!rect) return
      const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
      const bounds = constrainPanel(drag.resize ? { ...drag.original, width: drag.original.width + dx, height: drag.original.height + dy }
        : { ...drag.original, x: drag.original.x + dx, y: drag.original.y + dy }, rect)
      setDrag(previous => previous ? { ...previous, moved: true, bounds, target: drag.resize ? null : dockTargetAt(event.clientX - rect.x, event.clientY - rect.y, rect) } : null)
    }
    const release = () => { if (drag.moved) finish(drag.id, drag.bounds, drag.target); setDrag(null) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', release)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', release) }
  }, [drag, host, finish])

  const start = (id: PanelId, event: MouseEvent<HTMLElement>, resize = false) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, summary, details')) return
    const rect = host.current?.getBoundingClientRect()
    const frame = event.currentTarget.closest('.dock-panel')?.getBoundingClientRect()
    if (!rect || !frame) return
    event.preventDefault()
    const original = constrainPanel({ x: frame.x - rect.x, y: frame.y - rect.y,
      width: Math.min(frame.width, rect.width * .8), height: Math.min(frame.height, rect.height * .8) }, rect)
    setDrag({ id, startX: event.clientX, startY: event.clientY, original, resize, moved: false, bounds: original, target: null })
  }
  return { drag, start }
}
