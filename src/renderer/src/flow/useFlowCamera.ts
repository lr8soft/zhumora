import { useCallback, useEffect, useRef, useState } from 'react'
import { getViewportForBounds, useReactFlow, type OnMove, type Viewport } from '@xyflow/react'
import type { ConversationGraph, FlowNode } from './types'
import { shouldRecoverFlowViewport } from './viewportRecovery'
import { centerAtZoom, clampCameraZoom, isZoomGesture } from './cameraZoom'

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
  const previousGraph = useRef(graph)
  const customZoom = useRef<number | null>(null)
  const zooming = useRef(false)
  const automaticMoves = useRef(0)
  const lastViewport = useRef<Viewport>({ x: 0, y: 0, zoom: 1 })
  const cancel = useCallback(() => {
    if (pending.current) pending.current.owner.cancelAnimationFrame(pending.current.frame)
    pending.current = null
  }, [])
  const focus = useCallback((mode: 'all' | 'latest') => {
    cancel()
    if (zooming.current) return
    const owner = current.current.canvas?.ownerDocument.defaultView
    if (!owner) return
    const apply = () => {
      pending.current = null
      const { graph: snapshot, flow: viewport, canvas: element } = current.current
      if (!element?.isConnected || !viewport.viewportInitialized || !element.clientWidth || !element.clientHeight) return
      const target = snapshot.nodes.find(node => node.id === snapshot.latestNodeId)
      const bounds = graphBounds(mode === 'all' ? snapshot.nodes : target ? [target] : [])
      if (!bounds) return
      const next = mode === 'latest' && customZoom.current !== null
        ? centerAtZoom(bounds, element.clientWidth, element.clientHeight, customZoom.current)
        : getViewportForBounds(bounds, element.clientWidth, element.clientHeight, .08, 1, mode === 'all' ? .16 : .22)
      automaticMoves.current++
      void viewport.setViewport(next, { duration: 250 }).finally(() => { automaticMoves.current-- })
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
  const fitAll = useCallback(() => { customZoom.current = null; zooming.current = false; stopFollowing(); focus('all') }, [stopFollowing, focus])
  const focusLatest = useCallback(() => focus('latest'), [focus])
  const onInit = useCallback(() => { if (current.current.follow) focus('latest') }, [focus])
  const toggleFollow = useCallback(() => {
    const next = !current.current.follow
    current.current.follow = next
    if (!next) cancel()
    setFollow(next)
  }, [cancel])
  const onMoveStart: OnMove = (event, viewport) => {
    if (!event) return
    cancel()
    zooming.current = isZoomGesture(event)
    if (zooming.current) customZoom.current = viewport.zoom
    else stopFollowing()
  }
  const onMove: OnMove = (event, viewport) => {
    const previous = lastViewport.current
    lastViewport.current = viewport
    setZoom(viewport.zoom)
    if (!event && automaticMoves.current > 0) return
    if (event && !isZoomGesture(event)) {
      if (viewport.x !== previous.x || viewport.y !== previous.y) { zooming.current = false; stopFollowing() }
      return
    }
    if (Math.abs(viewport.zoom - previous.zoom) > .000001) {
      zooming.current = true; customZoom.current = viewport.zoom
    } else if (!event && !zooming.current && (viewport.x !== previous.x || viewport.y !== previous.y)) stopFollowing()
  }
  const onMoveEnd: OnMove = (event, viewport) => {
    if (!zooming.current) return
    if (!event && (automaticMoves.current > 0 || Math.abs(viewport.zoom - (customZoom.current ?? viewport.zoom)) > .000001)) return
    zooming.current = false
    if (current.current.follow) focus('latest')
  }
  const zoomBy = async (factor: number) => {
    cancel(); zooming.current = true
    const level = clampCameraZoom(current.current.flow.getZoom() * factor)
    customZoom.current = level
    await current.current.flow.zoomTo(level)
    zooming.current = false
    if (current.current.follow) focus('latest')
  }
  const topology = graph.nodes.map(node => `${node.id}:${node.position.x}:${node.position.y}:${node.width}:${node.height}`).join('|')
  useEffect(() => {
    const previous = previousGraph.current
    previousGraph.current = graph
    const element = current.current.canvas
    if (!flow.viewportInitialized || !element) return
    if (follow || shouldRecoverFlowViewport(previous, graph, flow.getViewport(), element.clientWidth, element.clientHeight)) focus('latest')
  }, [topology, follow, flow.viewportInitialized, focus])
  useEffect(() => {
    if (!canvas) return
    const observer = new ResizeObserver(() => { if (current.current.follow) focus('latest') })
    observer.observe(canvas)
    return () => { observer.disconnect(); cancel() }
  }, [canvas, focus, cancel])
  useEffect(() => cancel, [cancel])
  return { follow, zoom, setCanvas, stopFollowing, toggleFollow, fitAll, focusLatest, onInit,
    onMoveStart, onMove, onMoveEnd, zoomIn: () => void zoomBy(1.2), zoomOut: () => void zoomBy(1 / 1.2) }
}
