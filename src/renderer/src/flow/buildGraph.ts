import type { Session, UIMessage } from '../../../shared/types.ts'
import { collectDelegations, decodeTaskReferences, graphNodeId, splitConversationTurns, type Delegation } from './history.ts'
import { buildTurnNodes, flowNode, foldedTurn } from './projection.ts'
import { FLOW_GAP, FLOW_SIZE, type ConversationGraph, type FlowEdge, type FlowNode } from './types.ts'
import { compactTurnNodes, flowSteps, includesBoundary } from './compactNodes.ts'
import { finishGraphLayout } from './graphLayout.ts'
import type { SpeechSizing } from './speechSizing.ts'
import { turnStatus } from './status.ts'
import { withTaskSnapshots } from './taskSnapshots.ts'

export interface GraphInput {
  sessionId: string
  sessions: readonly Session[]
  messages: Readonly<Record<string, readonly UIMessage[]>>
  runningIds: ReadonlySet<string>
  collapsedTurns?: ReadonlySet<string>
  showChildren?: boolean
  detailLevel?: 'compact' | 'steps'
  speechSizing?: SpeechSizing
  compaction?: { upToMessageId: string; summary?: string } | null
}

interface Branch { taskId: string; sessionId: string; first: FlowNode; last: FlowNode }
interface ReturnedBranch { branch: Branch; stepId: string }

/** Pure, disposable projection: IDs and tool/result associations are scoped to authoritative sessions. */
export function buildConversationGraph(input: GraphInput): ConversationGraph {
  const messages = input.messages[input.sessionId] ?? []
  const turns = splitConversationTurns(messages)
  const delegations = withTaskSnapshots(input.sessionId, messages,
    collectDelegations(input.sessionId, messages, input.sessions, input.messages))
  const graph: ConversationGraph = { nodes: [], edges: [], turnIds: turns.map(turn => turn.id), childCount: 0 }
  const branches = new Map<string, Branch>()
  const laneEnds: number[] = []
  const childIds = new Set<string>()
  let cursor: number = FLOW_SIZE.left
  let previous: FlowNode | undefined
  for (const turn of turns) {
    const collapsed = input.collapsedTurns?.has(turn.id) && turn !== turns.at(-1)
    const raw = collapsed ? [foldedTurn(turn, input.sessionId)]
      : buildTurnNodes(turn, input.sessionId, input.runningIds.has(input.sessionId) && turn === turns.at(-1))
    const nodes = input.detailLevel === 'steps' ? raw : compactTurnNodes(raw, input.compaction?.upToMessageId, input.speechSizing?.width)
    for (const node of nodes) {
      annotateJoin(node, input.runningIds.has(input.sessionId) && turn === turns.at(-1))
      const priorReturns = branchesReturnedTo(node, branches)
      cursor = Math.max(cursor, ...priorReturns.map(item => item.branch.last.position.x + item.branch.last.width + FLOW_GAP))
      node.position = { x: cursor, y: FLOW_SIZE.top }
      graph.nodes.push(node)
      if (previous) connect(graph, previous, node, 'sequence')
      const returned = new Map<string, ReturnedBranch>()
      for (const step of flowSteps(node)) {
        const delegation = delegations.get(step.id)
        if (delegation) {
          step.data.childSessionId = delegation.session.id
          step.data.taskId = delegation.task.task_id
          const branch = addBranch(graph, node, delegation, input, laneEnds)
          branches.set(branch.taskId, branch)
          childIds.add(branch.sessionId)
        }
        for (const item of branchesReturnedTo({ ...node, id: step.id, data: step.data }, branches)) returned.set(item.branch.taskId, item)
      }
      for (const item of returned.values()) connect(graph, item.branch.last, node, 'return', { targetStepId: item.stepId })
      cursor = Math.max(node.position.x + node.width + FLOW_GAP,
        ...[...returned.values()].map(item => item.branch.last.position.x + item.branch.last.width + FLOW_GAP))
      previous = node
      if (flowSteps(node).some(step => includesBoundary(step, input.compaction?.upToMessageId))) {
        const marker = flowNode(graphNodeId('compaction', input.sessionId, input.compaction!.upToMessageId), {
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
  finishGraphLayout(graph, undefined, input.speechSizing?.fontSize)
  return graph
}

function connect(graph: ConversationGraph, source: FlowNode, target: FlowNode, kind: FlowEdge['kind'], trace: Pick<FlowEdge, 'sourceStepId' | 'targetStepId'> = {}): void {
  graph.edges.push({ id: graphNodeId(kind, source.id, target.id), source: source.id, target: target.id, kind, ...trace })
}

function branchesReturnedTo(node: FlowNode, branches: ReadonlyMap<string, Branch>): ReturnedBranch[] {
  const returned = new Map<string, ReturnedBranch>()
  for (const step of flowSteps(node)) {
    if (step.data.kind !== 'join' || !step.data.result || step.data.result.status === 'error') continue
    for (const task of decodeTaskReferences(step.data.result.content)) {
      const branch = branches.get(task.task_id)
      // Completion alone does not join a child: only an actual terminal result fetched by this wait call does.
      if (branch && branch.sessionId === task.session_id && ['completed', 'failed', 'aborted'].includes(task.status)
        && (!task.parentSessionId || task.parentSessionId === node.data.sessionId)) returned.set(task.task_id, { branch, stepId: step.id })
    }
  }
  return [...returned.values()]
}

function annotateJoin(node: FlowNode, running: boolean): void {
  const tasks = new Map(flowSteps(node).filter(step => step.data.kind === 'join' && step.data.result?.status !== 'error')
    .flatMap(step => step.data.result ? decodeTaskReferences(step.data.result.content) : []).map(task => [task.task_id, task]))
  if (!tasks.size) return
  node.data.totalTaskCount = tasks.size
  node.data.returnedTaskCount = [...tasks.values()].filter(task => ['completed', 'failed', 'aborted'].includes(task.status)).length
  if (node.data.kind !== 'speech' && node.data.steps && node.data.returnedTaskCount < tasks.size) node.data.status = running ? 'running' : 'unresolved'
}

function addBranch(
  graph: ConversationGraph, source: FlowNode, delegation: Delegation, input: GraphInput, laneEnds: number[]
): Branch {
  const { session, task, turn } = delegation
  const lastTurn = splitConversationTurns(input.messages[session.id] ?? []).at(-1)
  const running = input.runningIds.has(session.id) && (!turn || turn.id === lastTurn?.id)
    && !['completed', 'failed', 'aborted'].includes(task.status)
  const status = turnStatus(turn?.messages ?? [], running, task)
  const expanded = input.showChildren !== false && turn
  const raw = expanded ? buildTurnNodes(turn, session.id, running) : []
  const nodes = input.detailLevel === 'steps' ? raw : compactTurnNodes(raw, undefined, input.speechSizing?.width)
  if (!nodes.length) nodes.push(flowNode(graphNodeId('task', session.id, task.task_id), {
    kind: 'delegate', sessionId: session.id, title: session.title, preview: session.subagent?.model ?? '',
    status, childSessionId: session.id,
    taskId: task.task_id, messageCount: turn?.messages.length
  }))
  let lane = laneEnds.findIndex(end => end + FLOW_SIZE.column < source.position.x)
  if (lane < 0) lane = laneEnds.length
  const y = FLOW_SIZE.top + FLOW_SIZE.row * (lane + 1)
  const x = source.data.kind === 'speech' ? source.position.x : source.position.x + FLOW_SIZE.column
  let childCursor = x
  nodes.forEach((node, index) => {
    node.position = { x: childCursor, y }
    childCursor += node.width + FLOW_GAP
    node.data.taskId = task.task_id
    for (const step of node.data.steps ?? []) step.data.taskId = task.task_id
    // Child turns have their own IDs; the root turn anchor is kept on the lane for collapsed-history navigation.
    graph.nodes.push(node)
    if (index > 0) connect(graph, nodes[index - 1], node, 'sequence')
  })
  laneEnds[lane] = nodes.at(-1)!.position.x + nodes.at(-1)!.width
  const group = flowNode(graphNodeId('lane', session.id, task.task_id), {
    kind: 'lane', sessionId: session.id, childSessionId: session.id, taskId: task.task_id,
    turnId: source.data.turnId, title: session.title, preview: session.subagent?.model ?? '', laneIndex: lane,
    status
  })
  group.position = { x: x - 16, y: y - 40 }
  group.width = nodes.at(-1)!.position.x - x + nodes.at(-1)!.width + 32
  group.height = FLOW_SIZE.height + 60
  graph.nodes.push(group)
  connect(graph, source, nodes[0], 'delegate', { sourceStepId: delegation.nodeId })
  return { taskId: task.task_id, sessionId: session.id, first: nodes[0], last: nodes.at(-1)! }
}
