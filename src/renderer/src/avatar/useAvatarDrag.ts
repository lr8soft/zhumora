import { useEffect, useRef, type MouseEvent, type PointerEvent, type RefObject } from 'react'
import type { AvatarScene } from './AvatarScene'

export function useAvatarDrag(scene: RefObject<AvatarScene | null>, reportError: (message: string) => void) {
  const dragging = useRef<HTMLElement | null>(null)
  const pointerId = useRef<number | null>(null)
  const passthrough = useRef(true)
  const frame = useRef(0)
  const fail = (error: unknown) => reportError(error instanceof Error ? error.message : String(error))

  const stop = () => {
    const element = dragging.current
    if (!element) return
    dragging.current = null
    cancelAnimationFrame(frame.current)
    frame.current = 0
    element.classList.remove('dragging')
    const id = pointerId.current
    pointerId.current = null
    if (id !== null && element.hasPointerCapture(id)) element.releasePointerCapture(id)
    passthrough.current = true
    void window.avatarApi.drag('end').catch(fail)
  }

  const accepts = (target: EventTarget, x: number, y: number) =>
    (target instanceof Element && !!target.closest('[data-avatar-drag]')) || !!scene.current?.hitTest(x, y)

  const hover = (event: MouseEvent<HTMLDivElement>) => {
    if (dragging.current) return
    const ignore = !accepts(event.target, event.clientX, event.clientY)
    if (ignore === passthrough.current) return
    passthrough.current = ignore
    event.currentTarget.classList.toggle('can-drag', !ignore)
    void window.avatarApi.setPointerPassthrough(ignore).catch(fail)
  }

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !accepts(event.target, event.clientX, event.clientY)) return
    event.preventDefault()
    dragging.current = event.currentTarget
    pointerId.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.classList.add('dragging')
    passthrough.current = false
    void window.avatarApi.drag('start').catch(error => { stop(); fail(error) })
  }

  const move = () => {
    if (!dragging.current || frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      if (dragging.current) void window.avatarApi.drag('move').catch(error => { stop(); fail(error) })
    })
  }

  useEffect(() => {
    const blur = () => {
      stop()
      passthrough.current = true
      void window.avatarApi.setPointerPassthrough(true).catch(fail)
    }
    window.addEventListener('blur', blur)
    return () => { window.removeEventListener('blur', blur); stop() }
  }, [])

  return {
    onMouseMove: hover,
    onMouseLeave: () => {
      if (dragging.current) return
      passthrough.current = true
      void window.avatarApi.setPointerPassthrough(true).catch(fail)
    },
    onPointerDown: down, onPointerMove: move,
    onPointerUp: stop, onPointerCancel: stop, onLostPointerCapture: stop
  }
}
