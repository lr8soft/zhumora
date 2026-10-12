import { useCallback, useEffect, useRef, useState } from 'react'
import { getViewportForBounds, useReactFlow } from '@xyflow/react'
import type { ConversationGraph, FlowNode } from './types'

function graphBounds(nodes: readonly FlowNode[]) {
  if (!nodes.length) return null
  const x = Math.min(...nodes.map(node => node.position.x))
  const y = Math.min(...nodes.map(node => node.position.y))
  return { x, y, width: Math.max(...nodes.map(node => node.position.x + node.width)) - x,
    height: Math.max(...nodes.map(node => node.position.y + node.height)) - y }
}

/** Camera bounds come from the projection, including offscreen nodes never measured by React Flow. */
export function useFlowCamera(graph: ConversationGraph) {
  const flow = useReactFlow()
  const [follow, setFollow] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null)
  const current = useRef({ graph, flow, follow, canvas })
  current.current = { graph, flow, follow, canvas }
  const pending = useRef<{ owner: Window; frame: number } | null>(null)
  const cancel = useCallback(() => {
    if (pending.current) pending.current.owner.cancelAnimationFrame(pending.current.frame)
    pending.current = null
  }, [])
  const focus = useCallback((mode: 'all' | 'latest') => {
    cancel()
    const owner = current.current.canvas?.ownerDocument.defaultView
    if (!owner) return
    const apply = () => {
      pending.current = null
      const { graph: snapshot, flow: viewport, canvas: element } = current.current
      if (!element?.isConnected || !viewport.viewportInitialized || !element.clientWidth || !element.clientHeight) return
      const target = snapshot.nodes.find(node => node.id === snapshot.latestNodeId)
      const bounds = graphBounds(mode === 'all' ? snapshot.nodes : target ? [target] : [])
      if (!bounds) return
      const next = getViewportForBounds(bounds, element.clientWidth, element.clientHeight, .08, 1, mode === 'all' ? .16 : .22)
      void viewport.setViewport(next, { duration: 250 })
    }
    // Coalesce structural updates and let docking/inspector layout commit in the canvas's actual document.
    pending.current = { owner, frame: owner.requestAnimationFrame(() => {
      pending.current = { owner, frame: owner.requestAnimationFrame(apply) }
    }) }
  }, [cancel])
  const stopFollowing = useCallback(() => {
    current.current.follow = false
    cancel(); setFollow(false)
  }, [cancel])
  const fitAll = useCallback(() => { stopFollowing(); focus('all') }, [stopFollowing, focus])
  const focusLatest = useCallback(() => focus('latest'), [focus])
  const onInit = useCallback(() => { if (current.current.follow) focus('latest') }, [focus])
  const toggleFollow = useCallback(() => {
    const next = !current.current.follow
    current.current.follow = next
    if (!next) cancel()
    setFollow(next)
  }, [cancel])
  const topology = graph.nodes.map(node => `${node.id}:${node.position.x}:${node.position.y}:${node.width}:${node.height}`).join('|')
  useEffect(() => {
    if (follow && flow.viewportInitialized) focus('latest')
  }, [topology, follow, flow.viewportInitialized, focus])
  useEffect(() => {
    if (!canvas) return
    const observer = new ResizeObserver(() => { if (current.current.follow) focus('latest') })
    observer.observe(canvas)
    return () => { observer.disconnect(); cancel() }
  }, [canvas, focus, cancel])
  useEffect(() => cancel, [cancel])
  return { follow, zoom, setZoom, setCanvas, stopFollowing, toggleFollow, fitAll, focusLatest, onInit }
}
