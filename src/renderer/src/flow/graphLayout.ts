import { previewRowCount, previewSteps } from './nestedSteps.ts'
import { FLOW_SIZE, type ConversationGraph } from './types.ts'

/** Named inner ports retain exact tool provenance even when both dispatch and wait belong to one speech. */
export function finishGraphLayout(graph: ConversationGraph): void {
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  for (const edge of graph.edges) {
    const pairs = [
      { node: byId.get(edge.source), stepId: edge.sourceStepId, role: 'source' as const },
      { node: byId.get(edge.target), stepId: edge.targetStepId, role: 'target' as const }
    ]
    for (const { node, stepId, role } of pairs) {
      if (!node || node.data.kind !== 'speech' || !stepId) continue
      const ports = node.data.ports ??= []
      if (!ports.some(port => port.stepId === stepId && port.role === role)) ports.push({ stepId, role })
    }
  }
  for (const node of graph.nodes) {
    if (node.data.kind !== 'speech') continue
    const { hidden } = previewSteps(node.data)
    node.height = Math.max(264, 148 + previewRowCount(node.data) * 34 + (hidden ? 24 : 0))
  }
  const rootHeight = Math.max(FLOW_SIZE.height, ...graph.nodes.filter(node => !node.data.taskId).map(node => node.height))
  const rowHeight = Math.max(FLOW_SIZE.row, ...graph.nodes.filter(node => node.data.kind !== 'lane').map(node => node.height + 80))
  for (const lane of graph.nodes.filter(node => node.data.kind === 'lane')) {
    const members = graph.nodes.filter(node => node.data.taskId === lane.data.taskId && node.data.kind !== 'lane')
    const y = FLOW_SIZE.top + rootHeight + 80 + (lane.data.laneIndex ?? 0) * rowHeight
    members.forEach(node => { node.position.y = y })
    lane.position.y = y - 40
    lane.height = Math.max(FLOW_SIZE.height, ...members.map(node => node.height)) + 60
  }
}
