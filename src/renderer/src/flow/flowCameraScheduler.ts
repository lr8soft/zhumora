import { getViewportForBounds, type ReactFlowInstance, type Viewport } from '@xyflow/react'
import type { ConversationGraph } from './types'
import { cameraBounds, planCameraFollow } from './cameraFollow'
import { centerAtZoom } from './cameraZoom'

export type CameraMode = 'all' | 'latest' | 'active'
export interface PendingCameraFrame { owner: Window; frame: number; mode: CameraMode; force: boolean }
type Cell<T> = { current: T }
interface CameraSchedule {
  current: Cell<{ graph: ConversationGraph; flow: Pick<ReactFlowInstance, 'getViewport' | 'setViewport' | 'viewportInitialized'>; canvas: HTMLDivElement | null }>
  pending: Cell<PendingCameraFrame | null>
  zooming: Cell<boolean>
  customZoom: Cell<number | null>
  intendedViewport: Cell<Viewport | null>
  automaticMoves: Cell<number>
  cancel: () => void
  setHiddenActive: (count: number) => void
}

/** Shared owner-document scheduler for follow, explicit navigation and detached canvases. */
export function scheduleFlowCamera(state: CameraSchedule, mode: CameraMode, force = false): void {
  const { current, pending, zooming, customZoom, intendedViewport, automaticMoves, cancel, setHiddenActive } = state
    if (mode === 'active' && pending.current?.mode === 'latest') mode = 'latest'
    force ||= pending.current?.force ?? false
    cancel()
    if (zooming.current) return
    const owner = current.current.canvas?.ownerDocument.defaultView
    if (!owner) return
    const apply = () => {
      pending.current = null
      const { graph: snapshot, flow: viewport, canvas: element } = current.current
      if (!element?.isConnected || !viewport.viewportInitialized || !element.clientWidth || !element.clientHeight) return
      const target = snapshot.nodes.find(node => node.id === snapshot.latestNodeId)
      const bounds = cameraBounds(mode === 'all' ? snapshot.nodes : target ? [target] : [])
      if (!bounds) return
      const base = automaticMoves.current > 0 && intendedViewport.current ? intendedViewport.current : viewport.getViewport()
      const plan = mode === 'active' ? planCameraFollow(snapshot, base, element.clientWidth, element.clientHeight, customZoom.current, force) : null
      setHiddenActive(plan?.hiddenCount ?? 0)
      const next = plan ? plan.viewport : mode === 'latest' && customZoom.current !== null
        ? centerAtZoom(bounds, element.clientWidth, element.clientHeight, customZoom.current)
        : getViewportForBounds(bounds, element.clientWidth, element.clientHeight, .08, 1, mode === 'all' ? .16 : .22)
      if (!next) return
      intendedViewport.current = next
      automaticMoves.current++
      void viewport.setViewport(next, { duration: 250 }).finally(() => { automaticMoves.current-- })
    }
    // Coalesce structural updates and let docking/inspector layout commit in the canvas's actual document.
    pending.current = { owner, mode, force, frame: owner.requestAnimationFrame(() => {
      pending.current = { owner, mode, force, frame: owner.requestAnimationFrame(apply) }
    }) }
}
