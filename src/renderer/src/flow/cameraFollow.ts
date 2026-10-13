import type { ConversationGraph, FlowNode } from './types.ts'
import { CAMERA_ZOOM, centerAtZoom, clampCameraZoom } from './cameraZoom.ts'

export interface CameraViewport { x: number; y: number; zoom: number }
interface Bounds { x: number; y: number; width: number; height: number }

export function cameraBounds(nodes: readonly FlowNode[]): Bounds | null {
  if (!nodes.length) return null
  const x = Math.min(...nodes.map(node => node.position.x)), y = Math.min(...nodes.map(node => node.position.y))
  return { x, y, width: Math.max(...nodes.map(node => node.position.x + node.width)) - x,
    height: Math.max(...nodes.map(node => node.position.y + node.height)) - y }
}

/** One active frontier per session, plus the main conversation anchor. Decorative lanes and old work never attract the camera. */
export function activeCameraNodes(graph: ConversationGraph): FlowNode[] {
  const active = new Map<string, FlowNode>()
  const runningTasks = new Set(graph.nodes.filter(node => node.data.kind === 'lane' && node.data.status === 'running').map(node => node.data.taskId))
  for (const node of graph.nodes) {
    if (node.data.kind === 'lane' || node.data.kind === 'turn'
      || (!['running', 'queued'].includes(node.data.status) && (!node.data.taskId || !runningTasks.has(node.data.taskId)))) continue
    const prior = active.get(node.data.sessionId)
    const rank = (candidate: FlowNode) => candidate.data.status === 'running' ? 2 : candidate.data.status === 'queued' ? 1 : 0
    if (!prior || rank(node) > rank(prior) || (rank(node) === rank(prior) && node.position.x >= prior.position.x)) active.set(node.data.sessionId, node)
  }
  const main = graph.nodes.find(node => node.id === graph.latestNodeId && node.data.kind !== 'lane')
  const nodes = [...active.values()]
  return main ? [main, ...nodes.filter(node => node.id !== main.id && node.data.sessionId !== main.data.sessionId)] : nodes
}

function intersects(node: FlowNode, viewport: CameraViewport, width: number, height: number): boolean {
  const x = node.position.x * viewport.zoom + viewport.x, y = node.position.y * viewport.zoom + viewport.y
  return x < width && x + node.width * viewport.zoom > 0 && y < height && y + node.height * viewport.zoom > 0
}

function visibleCluster(nodes: FlowNode[], viewport: CameraViewport, width: number, height: number, zoom: number, gap: number): FlowNode[] {
  const anchor = nodes[0]
  const selected = [anchor]
  // Prefer branches already in view; stable geometry order prevents token timing from swapping the chosen cluster.
  const candidates = nodes.slice(1).sort((a, b) => Number(intersects(b, viewport, width, height)) - Number(intersects(a, viewport, width, height))
    || Math.abs(a.position.y - anchor.position.y) - Math.abs(b.position.y - anchor.position.y) || a.id.localeCompare(b.id))
  for (const node of candidates) {
    const bounds = cameraBounds([...selected, node])!
    if (bounds.width * zoom <= width - gap * 2 && bounds.height * zoom <= height - gap * 2) selected.push(node)
  }
  return selected
}

function contain(bounds: Bounds, viewport: CameraViewport, width: number, height: number, gap: number): CameraViewport {
  // A high custom zoom may make even one card larger than the screen. Keep a stable central reading region instead of bouncing between its edges.
  const regionWidth = Math.min(bounds.width, (width - gap * 2) / viewport.zoom)
  const regionHeight = Math.min(bounds.height, (height - gap * 2) / viewport.zoom)
  const region = { x: bounds.x + (bounds.width - regionWidth) / 2, y: bounds.y + (bounds.height - regionHeight) / 2,
    width: regionWidth, height: regionHeight }
  const shift = (start: number, size: number, extent: number) => start < gap ? gap - start
    : start + size > extent - gap ? extent - gap - start - size : 0
  const dx = shift(region.x * viewport.zoom + viewport.x, region.width * viewport.zoom, width)
  const dy = shift(region.y * viewport.zoom + viewport.y, region.height * viewport.zoom, height)
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy }
}

/** Pure viewport policy: fit concurrent frontiers when possible; otherwise retain zoom and a stable cluster. */
export function planCameraFollow(graph: ConversationGraph, viewport: CameraViewport, width: number, height: number,
  customZoom: number | null, force = false): { viewport: CameraViewport | null; hiddenCount: number } {
  const nodes = activeCameraNodes(graph)
  if (!nodes.length || width <= 0 || height <= 0) return { viewport: null, hiddenCount: 0 }
  const gap = Math.min(48, width * .08, height * .08)
  const bounds = cameraBounds(nodes)!
  const fitZoom = clampCameraZoom(Math.min(1, (width - gap * 2) / Math.max(1, bounds.width), (height - gap * 2) / Math.max(1, bounds.height)))
  let zoom = customZoom === null ? fitZoom : clampCameraZoom(customZoom)
  // During parallel work, only shrink when required. Finishing one branch must not cause a zoom-in/zoom-out cycle.
  if (!force && customZoom === null && nodes.length > 1) zoom = Math.min(viewport.zoom, zoom)
  const selected = bounds.width * zoom <= width - gap * 2 + .5 && bounds.height * zoom <= height - gap * 2 + .5
    ? nodes : visibleCluster(nodes, viewport, width, height, zoom, gap)
  const target = cameraBounds(selected)!
  const next = force || Math.abs(zoom - viewport.zoom) > .000001
    ? centerAtZoom(target, width, height, zoom) : contain(target, viewport, width, height, gap)
  const changed = Math.abs(next.x - viewport.x) > .5 || Math.abs(next.y - viewport.y) > .5 || Math.abs(next.zoom - viewport.zoom) > .000001
  return { viewport: changed ? next : null, hiddenCount: nodes.length - selected.length }
}
