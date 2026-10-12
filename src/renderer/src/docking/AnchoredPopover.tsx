import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Menus belong to their anchor's document, outside dock clipping and native-window containment. */
export default function AnchoredPopover({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [owner, setOwner] = useState<Document | null>(null)
  useLayoutEffect(() => { setOwner(anchor.current?.ownerDocument ?? null) }, [])
  useLayoutEffect(() => {
    const element = popup.current, button = anchor.current?.parentElement, view = owner?.defaultView
    if (!element || !button || !view) return
    const position = () => {
      const box = button.getBoundingClientRect()
      const above = box.top - 40, below = view.innerHeight - box.bottom - 8
      const upward = above >= below
      element.style.maxHeight = `${Math.max(60, upward ? above : below)}px`
      const bounds = element.getBoundingClientRect()
      element.style.left = `${Math.max(8, Math.min(box.right - bounds.width, view.innerWidth - bounds.width - 8))}px`
      element.style.top = `${upward ? Math.max(36, box.top - bounds.height - 6) : box.bottom + 6}px`
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const observer = new ResizeObserver(position)
    observer.observe(element); observer.observe(button)
    view.addEventListener('resize', position); view.addEventListener('keydown', key)
    position()
    return () => { observer.disconnect(); view.removeEventListener('resize', position); view.removeEventListener('keydown', key) }
  }, [owner, onClose])
  return <><span className="popover-anchor" ref={anchor} />{owner && createPortal(<>
    <div className="mode-menu-backdrop" onClick={onClose} />
    <div className="dock-popover" ref={popup}>{children}</div>
  </>, owner.body)}</>
}
