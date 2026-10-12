import type { ConversationGraph } from './types.ts'

interface Viewport { x: number; y: number; zoom: number }

export function hasVisibleFlowNodes(graph: ConversationGraph, viewport: Viewport, width: number, height: number): boolean {
  return graph.nodes.some(node => {
    if (node.data.kind === 'lane') return false
    const x = node.position.x * viewport.zoom + viewport.x
    const y = node.position.y * viewport.zoom + viewport.y
    return x < width && x + node.width * viewport.zoom > 0
      && y < height && y + node.height * viewport.zoom > 0
  })
}

/** Recover only when a graph change removes everything from a previously useful view. */
export function shouldRecoverFlowViewport(previous: ConversationGraph, next: ConversationGraph,
  viewport: Viewport, width: number, height: number): boolean {
  if (width <= 0 || height <= 0 || !next.nodes.some(node => node.data.kind !== 'lane')) return false
  if (![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom <= 0) return true
  return hasVisibleFlowNodes(previous, viewport, width, height) && !hasVisibleFlowNodes(next, viewport, width, height)
}
