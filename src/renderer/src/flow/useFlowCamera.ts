import { useCallback, useEffect, useRef, useState } from 'react'
import { useReactFlow, type OnMove, type Viewport } from '@xyflow/react'
import type { ConversationGraph } from './types'
import { shouldRecoverFlowViewport } from './viewportRecovery'
import { clampCameraZoom, isZoomGesture } from './cameraZoom'
import { activeCameraNodes } from './cameraFollow'
import { scheduleFlowCamera, type CameraMode, type PendingCameraFrame } from './flowCameraScheduler'

/** Camera bounds come from the projection, including offscreen nodes never measured by React Flow. */
export function useFlowCamera(graph: ConversationGraph) {
  const flow = useReactFlow()
  const [follow, setFollow] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [hiddenActive, setHiddenActive] = useState(0)
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null)
  const current = useRef({ graph, flow, follow, canvas })
  current.current = { graph, flow, follow, canvas }
  const pending = useRef<PendingCameraFrame | null>(null)
  const previousGraph = useRef(graph)
  const customZoom = useRef<number | null>(null)
  const zooming = useRef(false)
  const automaticMoves = useRef(0)
  const intendedViewport = useRef<Viewport | null>(null)
  const lastViewport = useRef<Viewport>({ x: 0, y: 0, zoom: 1 })
  const cancel = useCallback(() => {
    if (pending.current) pending.current.owner.cancelAnimationFrame(pending.current.frame)
    pending.current = null
  }, [])
  const focus = useCallback((mode: CameraMode, force = false) => scheduleFlowCamera({
    current, pending, zooming, customZoom, intendedViewport, automaticMoves, cancel, setHiddenActive
  }, mode, force), [cancel])
  const stopFollowing = useCallback(() => {
    current.current.follow = false
    cancel(); setFollow(false)
  }, [cancel])
  const fitAll = useCallback(() => { customZoom.current = null; zooming.current = false; stopFollowing(); focus('all') }, [stopFollowing, focus])
  const focusLatest = useCallback(() => focus('latest'), [focus])
  const fitActive = useCallback(() => { customZoom.current = null; zooming.current = false; focus('active', true) }, [focus])
  const onInit = useCallback(() => { if (current.current.follow) focus('active', true) }, [focus])
  const toggleFollow = useCallback(() => {
    const next = !current.current.follow
    current.current.follow = next
    if (!next) cancel()
    else focus('active', true)
    setFollow(next)
  }, [cancel, focus])
  const onMoveStart: OnMove = (event, viewport) => {
    if (!event) return
    cancel()
    intendedViewport.current = null
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
    if (current.current.follow) focus('active')
  }
  const zoomBy = async (factor: number) => {
    cancel(); intendedViewport.current = null; zooming.current = true
    const level = clampCameraZoom(current.current.flow.getZoom() * factor)
    customZoom.current = level
    await current.current.flow.zoomTo(level)
    zooming.current = false
    if (current.current.follow) focus('active')
  }
  const topology = graph.nodes.map(node => `${node.id}:${node.position.x}:${node.position.y}:${node.width}:${node.height}`).join('|')
  const activeTopology = activeCameraNodes(graph).map(node => `${node.id}:${node.data.status}`).join('|')
  useEffect(() => {
    const previous = previousGraph.current
    previousGraph.current = graph
    const element = current.current.canvas
    if (!flow.viewportInitialized || !element) return
    if (follow) focus('active')
    else if (shouldRecoverFlowViewport(previous, graph, flow.getViewport(), element.clientWidth, element.clientHeight)) focus('latest')
  }, [topology, activeTopology, follow, flow.viewportInitialized, focus])
  useEffect(() => {
    if (!canvas) return
    const observer = new ResizeObserver(() => { if (current.current.follow) focus('active') })
    observer.observe(canvas)
    return () => { observer.disconnect(); cancel() }
  }, [canvas, focus, cancel])
  useEffect(() => cancel, [cancel])
  return { follow, zoom, hiddenActive, fitActive, setCanvas, stopFollowing, toggleFollow, fitAll, focusLatest, onInit,
    onMoveStart, onMove, onMoveEnd, zoomIn: () => void zoomBy(1.2), zoomOut: () => void zoomBy(1 / 1.2) }
}
