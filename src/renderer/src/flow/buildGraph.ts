import type { Session, UIMessage } from '../../../shared/types.ts'
import { collectDelegations, decodeTaskReferences, messageNodeId, splitConversationTurns, type Delegation } from './history.ts'
import { buildTurnNodes, flowNode, foldedTurn } from './projection.ts'
import { FLOW_SIZE, type ConversationGraph, type FlowEdge, type FlowNode } from './types.ts'

export interface GraphInput {
  sessionId: string
  sessions: readonly Session[]
  messages: Readonly<Record<string, readonly UIMessage[]>>
  runningIds: ReadonlySet<string>
  collapsedTurns?: ReadonlySet<string>
  showChildren?: boolean
  compaction?: { upToMessageId: string; summary?: string } | null
}

interface Branch { taskId: string; sessionId: string; first: FlowNode; last: FlowNode }

/** Pure, disposable projection: IDs and tool/result associations are scoped to authoritative sessions. */
export function buildConversationGraph(input: GraphInput): ConversationGraph {
  const messages = input.messages[input.sessionId] ?? []
  const turns = splitConversationTurns(messages)
  const delegations = collectDelegations(input.sessionId, messages, input.sessions, input.messages)
  const graph: ConversationGraph = { nodes: [], edges: [], turnIds: turns.map(turn => turn.id), childCount: 0 }
  const branches = new Map<string, Branch>()
  const laneEnds: number[] = []
  const childIds = new Set<string>()
  let cursor: number = FLOW_SIZE.left
  let previous: FlowNode | undefined
  for (const turn of turns) {
    const collapsed = input.collapsedTurns?.has(turn.id) && turn !== turns.at(-1)
    const nodes = collapsed ? [foldedTurn(turn, input.sessionId)]
      : buildTurnNodes(turn, input.sessionId, input.runningIds.has(input.sessionId) && turn === turns.at(-1))
    for (const node of nodes) {
      const returnedBranches = branchesReturnedTo(node, branches)
      if (node.data.kind === 'join' && node.data.result) {
        const tasks = decodeTaskReferences(node.data.result.content)
        if (tasks.length) {
          node.data.totalTaskCount = tasks.length
          node.data.returnedTaskCount = tasks.filter(task => ['completed', 'failed', 'aborted'].includes(task.status)).length
        }
      }
      cursor = Math.max(cursor, ...returnedBranches.map(branch => branch.last.position.x + FLOW_SIZE.column))
      node.position = { x: cursor, y: FLOW_SIZE.top }
      graph.nodes.push(node)
      if (previous) connect(graph, previous, node, 'sequence')
      for (const branch of returnedBranches) connect(graph, branch.last, node, 'return')
      const delegation = node.data.call && delegations.get(node.id)
      if (delegation) {
        node.data.childSessionId = delegation.session.id
        node.data.taskId = delegation.task.task_id
        node.data.preview = `${delegation.session.title}\n${delegation.session.subagent?.model ?? ''}`
        const branch = addBranch(graph, node, delegation, input, laneEnds)
        branches.set(branch.taskId, branch)
        childIds.add(branch.sessionId)
      }
      cursor = node.position.x + FLOW_SIZE.column
      previous = node
      if (isCompactionBoundary(node, input.compaction?.upToMessageId)) {
        const marker = flowNode(JSON.stringify(['compaction', input.sessionId, input.compaction!.upToMessageId]), {
          kind: 'compaction', sessionId: input.sessionId, title: '', preview: input.compaction?.summary ?? '',
          status: 'done', turnId: turn.id
        })
        marker.position = { x: cursor, y: FLOW_SIZE.top }
        graph.nodes.push(marker)
        connect(graph, node, marker, 'sequence')
        previous = marker
        cursor += FLOW_SIZE.column
      }
    }
  }
  graph.latestNodeId = previous?.id
  graph.childCount = childIds.size
  return graph
}

function connect(graph: ConversationGraph, source: FlowNode, target: FlowNode, kind: FlowEdge['kind']): void {
  graph.edges.push({ id: JSON.stringify([kind, source.id, target.id]), source: source.id, target: target.id, kind })
}

function branchesReturnedTo(node: FlowNode, branches: ReadonlyMap<string, Branch>): Branch[] {
  if (node.data.kind !== 'join' || !node.data.result || node.data.result.status === 'error') return []
  return decodeTaskReferences(node.data.result.content).flatMap(task => {
    const branch = branches.get(task.task_id)
    // Completion alone does not join a child: only an actual terminal result fetched by this wait call does.
    return branch && branch.sessionId === task.session_id && ['completed', 'failed', 'aborted'].includes(task.status)
      && (!task.parentSessionId || task.parentSessionId === node.data.sessionId) ? [branch] : []
  })
}

function addBranch(
  graph: ConversationGraph, source: FlowNode, delegation: Delegation, input: GraphInput, laneEnds: number[]
): Branch {
  const { session, task, turn } = delegation
  const lastTurn = splitConversationTurns(input.messages[session.id] ?? []).at(-1)
  const running = input.runningIds.has(session.id) && (!turn || turn.id === lastTurn?.id)
  const expanded = input.showChildren !== false && turn
  const nodes = expanded ? buildTurnNodes(turn, session.id, running) : []
  if (!nodes.length) nodes.push(flowNode(JSON.stringify(['task', session.id, task.task_id]), {
    kind: 'delegate', sessionId: session.id, title: session.title, preview: session.subagent?.model ?? '',
    status: running ? 'running' : turn?.messages.some(message => message.status === 'error') ? 'error' : turn ? 'done' : 'unresolved', childSessionId: session.id,
    taskId: task.task_id, messageCount: turn?.messages.length
  }))
  let lane = laneEnds.findIndex(end => end + FLOW_SIZE.column < source.position.x)
  if (lane < 0) lane = laneEnds.length
  const y = FLOW_SIZE.top + FLOW_SIZE.row * (lane + 1)
  const x = source.position.x + FLOW_SIZE.column
  nodes.forEach((node, index) => {
    node.position = { x: x + index * FLOW_SIZE.column, y }
    node.data.taskId = task.task_id
    // Child turns have their own IDs; the root turn anchor is kept on the lane for collapsed-history navigation.
    graph.nodes.push(node)
    if (index > 0) connect(graph, nodes[index - 1], node, 'sequence')
  })
  laneEnds[lane] = nodes.at(-1)!.position.x + FLOW_SIZE.width
  const group = flowNode(JSON.stringify(['lane', session.id, task.task_id]), {
    kind: 'lane', sessionId: session.id, childSessionId: session.id, taskId: task.task_id,
    turnId: source.data.turnId, title: session.title, preview: session.subagent?.model ?? '',
    status: running ? 'running' : nodes.some(node => node.data.status === 'error') ? 'error'
      : nodes.some(node => node.data.status === 'unresolved') ? 'unresolved' : 'done'
  })
  group.position = { x: x - 16, y: y - 40 }
  group.width = nodes.at(-1)!.position.x - x + FLOW_SIZE.width + 32
  group.height = FLOW_SIZE.height + 60
  graph.nodes.push(group)
  connect(graph, source, nodes[0], 'delegate')
  return { taskId: task.task_id, sessionId: session.id, first: nodes[0], last: nodes.at(-1)! }
}

function isCompactionBoundary(node: FlowNode, boundary?: string): boolean {
  if (!boundary) return false
  if (node.data.result?.id === boundary) return true
  return node.data.message?.id === boundary && !node.data.call
    && node.id === messageNodeId(node.data.sessionId, boundary)
}
