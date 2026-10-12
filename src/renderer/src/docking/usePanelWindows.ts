import { useCallback, useEffect, useRef, useState } from 'react'
import type { PanelId } from '../../../shared/panels'

export interface PanelPortal { key: string; window: Window; container: HTMLElement }

/** The child DOM hosts the same React tree/store. It never initializes another App, Agent adapter or TTS player. */
export function usePanelWindows(onReturn: (id: PanelId) => void) {
  const [portals, setPortals] = useState<Partial<Record<PanelId, PanelPortal>>>({})
  const current = useRef(portals)
  const mounted = useRef(true)
  const returning = useRef(onReturn)
  current.current = portals
  returning.current = onReturn
  const returned = useCallback((key: string) => {
    const entry = Object.entries(current.current).find(([, portal]) => portal?.key === key)
    if (!entry) return
    const id = entry[0] as PanelId
    const next = { ...current.current }; delete next[id]; current.current = next
    setPortals(next)
    returning.current(id)
  }, [])

  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.api.panels.onClosed(({ key }) => returned(key))
    return () => {
      mounted.current = false
      unsubscribe()
      for (const portal of Object.values(current.current)) portal?.window.close()
    }
  }, [returned])

  const open = useCallback(async (id: PanelId, title: string) => {
    const existing = current.current[id]
    if (existing && !existing.window.closed) { existing.window.focus(); return }
    const { key } = await window.api.panels.prepare(id)
    if (!mounted.current) return
    const child = window.open('about:blank', key, `width=${id === 'conversation' ? 1100 : 520},height=760`)
    if (!child) throw new Error('Panel window could not open')
    const container = child.document.createElement('div')
    container.className = 'panel-window-root'
    child.document.title = `${title} · Zhumora`
    child.document.body.append(container)
    child.addEventListener('pagehide', () => returned(key), { once: true })
    setPortals(previous => ({ ...previous, [id]: { key, window: child, container } }))
  }, [returned])

  const close = useCallback((id: PanelId) => {
    const portal = current.current[id]
    if (portal) {
      const next = { ...current.current }; delete next[id]; current.current = next
      setPortals(next)
      portal.window.close()
    }
  }, [])
  return { portals, open, close }
}
