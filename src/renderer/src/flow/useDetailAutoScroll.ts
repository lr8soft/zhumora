import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Follow the selected detail, without moving a reader who has scrolled back. */
export function useDetailAutoScroll(scope: string, text: string, active: boolean) {
  const [body, setBody] = useState<HTMLDivElement | null>(null)
  const following = useRef(active)
  const paused = useRef(false)
  const lastTop = useRef(0)

  useLayoutEffect(() => {
    following.current = active
    paused.current = false
    if (body) body.scrollTop = active ? body.scrollHeight : 0
    lastTop.current = body?.scrollTop ?? 0
    // Each selected step/tab starts its own reading position.
  }, [body, scope])

  useLayoutEffect(() => {
    if (active) following.current = true
    if (body && following.current && !paused.current) {
      body.scrollTop = body.scrollHeight
      lastTop.current = body.scrollTop
    }
  }, [body, scope, text, active])

  useEffect(() => {
    const owner = body?.ownerDocument.defaultView
    if (!body || !owner) return
    let frame: number | null = null
    const schedule = () => {
      if (frame !== null || !following.current || paused.current) return
      frame = owner.requestAnimationFrame(() => {
        frame = null
        if (!following.current || paused.current) return
        body.scrollTop = body.scrollHeight
        lastTop.current = body.scrollTop
      })
    }
    const onScroll = () => {
      const atBottom = body.scrollHeight - body.clientHeight - body.scrollTop <= 32
      if (atBottom) paused.current = false
      else if (body.scrollTop < lastTop.current - 1) paused.current = true
      lastTop.current = body.scrollTop
    }
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0 && body.scrollTop > 0) paused.current = true }
    const onKey = (event: KeyboardEvent) => {
      if (body.scrollTop > 0 && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) paused.current = true
    }
    // Markdown, diagrams and images can change height after the token render.
    const resize = new owner.ResizeObserver(schedule)
    resize.observe(body)
    if (body.firstElementChild) resize.observe(body.firstElementChild)
    const mutation = new owner.MutationObserver(schedule)
    mutation.observe(body, { childList: true, subtree: true, characterData: true })
    body.addEventListener('scroll', onScroll, { passive: true })
    body.addEventListener('wheel', onWheel, { passive: true })
    body.addEventListener('keydown', onKey)
    return () => {
      if (frame !== null) owner.cancelAnimationFrame(frame)
      resize.disconnect(); mutation.disconnect()
      body.removeEventListener('scroll', onScroll)
      body.removeEventListener('wheel', onWheel)
      body.removeEventListener('keydown', onKey)
    }
  }, [body, scope])

  return setBody
}
