import { FLOW_SIZE, type ConversationGraph, type FlowNode } from './types.ts'
import { estimateSpeechHeight } from './speechSizing.ts'

/** Named inner ports retain exact tool provenance even when both dispatch and wait belong to one speech. */
export function finishGraphLayout(graph: ConversationGraph, heights?: ReadonlyMap<string, number>, fontSize = 15): void {
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
    node.height = heights?.get(node.id) ?? estimateSpeechHeight(node.data, node.width, fontSize)
  }
  const rootHeight = Math.max(FLOW_SIZE.height, ...graph.nodes.filter(node => !node.data.taskId).map(node => node.height))
  const lanes = graph.nodes.filter(node => node.data.kind === 'lane')
  // Single pass: group task members once so lane sizing/positioning never rescans all nodes per lane.
  const membersByTask = new Map<string, FlowNode[]>()
  for (const node of graph.nodes) {
    if (node.data.kind === 'lane' || !node.data.taskId) continue
    const group = membersByTask.get(node.data.taskId)
    if (group) group.push(node)
    else membersByTask.set(node.data.taskId, [node])
  }
  const laneMembers = (lane: FlowNode) => (lane.data.taskId ? membersByTask.get(lane.data.taskId) ?? [] : [])
  const maxHeight = (nodes: FlowNode[]) => nodes.reduce<number>((max, node) => Math.max(max, node.height), FLOW_SIZE.height)
  const heightsByRow = new Map<number, number>()
  for (const lane of lanes) {
    const index = lane.data.laneIndex ?? 0
    heightsByRow.set(index, Math.max(heightsByRow.get(index) ?? FLOW_SIZE.height, maxHeight(laneMembers(lane))))
  }
  const starts = new Map<number, number>()
  let cursor = FLOW_SIZE.top + rootHeight + 80
  for (const [index, height] of [...heightsByRow].sort(([a], [b]) => a - b)) {
    starts.set(index, cursor)
    cursor += height + 80
  }
  for (const lane of lanes) {
    const members = laneMembers(lane)
    const y = starts.get(lane.data.laneIndex ?? 0)!
    members.forEach(node => { node.position.y = y })
    lane.position.y = y - 40
    lane.height = maxHeight(members) + 60
  }
}
