import { messageNodeId } from './history.ts'
import { flowNode } from './projection.ts'
import type { FlowNode, FlowStatus, FlowStep } from './types.ts'

/** Each actual utterance owns its reasoning/tools. Empty completed LLM rounds never create another speech node. */
export function compactTurnNodes(nodes: readonly FlowNode[], boundary?: string): FlowNode[] {
  const compact: FlowNode[] = []
  let group: FlowNode[] = []
  let spoken = false
  const flush = () => {
    if (group.length) compact.push(speechNode(group))
    group = []
    spoken = false
  }
  for (const node of nodes) {
    const internal = node.data.kind === 'llm' || !!node.data.call
    if (!internal) { flush(); compact.push(node); continue }
    const hasWords = node.data.kind === 'llm' && !!node.data.message?.content.trim()
    const preparingSpeech = node.data.kind === 'llm' && !node.data.message?.toolCalls?.length && node.data.status === 'running'
    // Allocate the live reply before its first text delta. A tool-only structural end event folds it back.
    if (spoken && (hasWords || preparingSpeech)) flush()
    group.push(node)
    if (hasWords) spoken = true
    if (includesBoundary(node, boundary)) flush()
  }
  flush()
  return compact
}

export function flowSteps(node: FlowNode): FlowStep[] {
  return node.data.steps ?? [{ id: node.id, data: node.data }]
}

export function includesBoundary(node: FlowStep, boundary?: string): boolean {
  if (!boundary) return false
  return node.data.result?.id === boundary || (!node.data.call && node.data.message?.id === boundary
    && node.id === messageNodeId(node.data.sessionId, boundary))
}

function speechNode(members: readonly FlowNode[]): FlowNode {
  const spoken = members.find(node => node.data.kind === 'llm' && node.data.message?.content.trim())
  const processing = [...members].reverse().find(node => node.data.kind === 'llm')
  const node = flowNode(members[0].id, {
    kind: 'speech', sessionId: members[0].data.sessionId, turnId: members[0].data.turnId, title: '',
    preview: spoken?.data.message?.content ?? '', message: spoken?.data.message ?? processing?.data.message,
    status: speechStatus(members), steps: members.map(member => ({ id: member.id, data: member.data })),
    toolCount: members.filter(node => node.data.call).length,
    llmCount: members.filter(node => node.data.kind === 'llm').length
  })
  node.width = 352
  node.height = 264
  return node
}

function speechStatus(steps: readonly FlowStep[]): FlowStatus {
  for (const status of ['running', 'queued', 'unresolved', 'error'] as const) {
    if (steps.some(step => step.data.status === status)) return status
  }
  return 'done'
}
