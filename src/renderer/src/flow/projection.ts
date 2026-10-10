import { COMPACT_SUMMARY_PREFIX, type UIMessage } from '../../../shared/types.ts'
import { indexToolResults, messageNodeId, toolNodeId, type ConversationTurn } from './history.ts'
import { FLOW_SIZE, type FlowData, type FlowNode, type FlowStatus } from './types.ts'

export function nodeStatus(message: UIMessage, running: boolean): FlowStatus {
  if (message.status === 'error') return 'error'
  if (['streaming', 'thinking', 'pending'].includes(message.status ?? '')) return running ? 'running' : 'unresolved'
  return 'done'
}

export function flowNode(id: string, data: FlowData): FlowNode {
  return { id, data, position: { x: 0, y: 0 }, width: FLOW_SIZE.width, height: FLOW_SIZE.height }
}

export function buildTurnNodes(turn: ConversationTurn, sessionId: string, running: boolean): FlowNode[] {
  const nodes: FlowNode[] = []
  const { results, mergedIds } = indexToolResults(turn.messages)
  let activeToolFound = false
  for (const message of turn.messages) {
    if (mergedIds.has(message.id)) continue
    const summary = message.role === 'user' && message.content.startsWith(COMPACT_SUMMARY_PREFIX)
    const kind = summary ? 'summary' : message.role === 'user' ? 'user' : message.role === 'tool' ? 'tool' : 'llm'
    nodes.push(flowNode(messageNodeId(sessionId, message.id), {
      kind, sessionId, turnId: turn.id, title: message.toolName ?? '',
      preview: summary ? message.content.slice(COMPACT_SUMMARY_PREFIX.length).trim() : message.content || message.reasoning || '',
      message, status: message.role === 'assistant' && message.toolCalls?.length && message.status !== 'error'
        ? 'done' : nodeStatus(message, running)
    }))
    for (const call of message.toolCalls ?? []) {
      const nodeId = toolNodeId(sessionId, call.id, message.id)
      const result = results.get(nodeId)
      // The runner executes ordinary calls serially. Later unreturned calls are queued, never parallel-running.
      const status: FlowStatus = result ? nodeStatus(result, false)
        : running ? activeToolFound ? 'queued' : 'running' : 'unresolved'
      if (!result) activeToolFound = true
      const kind = ['spawn_subagent', 'continue_subagent'].includes(call.function.name) ? 'delegate'
        : call.function.name === 'wait_subagents' ? 'join' : 'tool'
      nodes.push(flowNode(nodeId, {
        kind, sessionId, turnId: turn.id, title: call.function.name,
        preview: result?.content || call.function.arguments, status, message, call, result
      }))
    }
  }
  return nodes
}

export function foldedTurn(turn: ConversationTurn, sessionId: string): FlowNode {
  return flowNode(JSON.stringify(['turn', sessionId, turn.id]), {
    kind: 'turn', sessionId, turnId: turn.id, title: '', preview: turn.messages[0]?.content ?? '',
    message: turn.messages[0], messageCount: turn.messages.length,
    status: turn.messages.some(message => message.status === 'error') ? 'error' : 'done'
  })
}
