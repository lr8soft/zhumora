import { useEffect, useState, type MouseEvent, type RefObject } from 'react'
import type { DockSide } from './layout'

export function useDockSizes(host: RefObject<HTMLDivElement | null>) {
  const [sizes, setSizes] = useState({ left: 348, right: 348, top: 230, bottom: 230 })
  const [side, setSide] = useState<Exclude<DockSide, 'center'> | null>(null)
  useEffect(() => {
    if (!side) return
    const move = (event: globalThis.MouseEvent) => {
      const rect = host.current?.getBoundingClientRect()
      if (!rect) return
      const horizontal = side === 'left' || side === 'right'
      const requested = side === 'left' ? event.clientX - rect.x : side === 'right' ? rect.right - event.clientX
        : side === 'top' ? event.clientY - rect.y : rect.bottom - event.clientY
      const value = Math.max(horizontal ? 220 : 120, Math.min(requested, (horizontal ? rect.width : rect.height) * .7))
      setSizes(previous => ({ ...previous, [side]: value }))
    }
    const release = () => setSide(null)
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', release)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', release) }
  }, [host, side])
  const start = (edge: Exclude<DockSide, 'center'>, event: MouseEvent) => { event.preventDefault(); setSide(edge) }
  return { sizes, start }
}
