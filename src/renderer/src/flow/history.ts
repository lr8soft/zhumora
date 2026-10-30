import { COMPACT_SUMMARY_PREFIX, type Session, type UIMessage } from '../../../shared/types.ts'
import { hashStrings, memoize, messageDigest } from './memoize.ts'

export interface ConversationTurn { id: string; messages: UIMessage[] }
export interface TaskReference {
  task_id: string
  session_id: string
  status: 'running' | 'awaiting_permission' | 'completed' | 'failed' | 'aborted'
  parentSessionId?: string
  diagnostics?: { failure?: { stage?: string } }
}
export interface Delegation {
  callId: string
  nodeId: string
  task: TaskReference
  session: Session
  turn?: ConversationTurn
}

/** The original message order and objects remain authoritative; folding is a projection only. Cached until the array's structure (ids/order) changes; the result is read-only. */
export function splitConversationTurns(messages: readonly UIMessage[]): ConversationTurn[] {
  return memoize('splitConversationTurns', messageDigest(messages), () => computeTurns(messages))
}

function computeTurns(messages: readonly UIMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  for (const message of messages) {
    const userInput = message.role === 'user' && !message.coordination && !message.content.startsWith(COMPACT_SUMMARY_PREFIX)
    if (userInput || turns.length === 0) turns.push({ id: message.id, messages: [] })
    turns.at(-1)!.messages.push(message)
  }
  return turns
}

/** Decode only the built-in delegation protocol at one boundary; arbitrary tool output is never a graph instruction. */
export function decodeTaskReferences(content: string): TaskReference[] {
  if (content.length > 150000) return []
  try {
    const value: unknown = JSON.parse(content)
    const page = value && typeof value === 'object' && 'tasks' in value ? value.tasks : undefined
    return (Array.isArray(value) ? value : Array.isArray(page) ? page : [value]).filter((item): item is TaskReference => {
      if (!item || typeof item !== 'object') return false
      const record = item as Record<string, unknown>
      return typeof record.task_id === 'string' && !!record.task_id
        && typeof record.session_id === 'string' && !!record.session_id
        && ['running', 'awaiting_permission', 'completed', 'failed', 'aborted'].includes(String(record.status))
        && (record.parentSessionId === undefined || typeof record.parentSessionId === 'string')
    })
  } catch { return [] }
}

/** Session-boundary decode of the delegation protocol. Cached per structural identity of messages/sessions; the returned Map is read-only. */
export function collectDelegations(
  parentId: string, messages: readonly UIMessage[], sessions: readonly Session[],
  histories: Readonly<Record<string, readonly UIMessage[]>>
): Map<string, Delegation> {
  const key = [
    messageDigest(messages),
    hashStrings(sessions.map(session => `${session.id}:${session.title}:${session.subagent?.model ?? ''}`)),
    hashStrings(Object.keys(histories).sort().map(id => `${id}:${messageDigest(histories[id] ?? [])}`))
  ].join('|')
  return memoize(`collectDelegations:${parentId}`, key, () => computeDelegations(parentId, messages, sessions, histories))
}

function computeDelegations(
  parentId: string, messages: readonly UIMessage[], sessions: readonly Session[],
  histories: Readonly<Record<string, readonly UIMessage[]>>
): Map<string, Delegation> {
  const children = new Map(sessions.filter(session => session.subagent?.parentSessionId === parentId).map(session => [session.id, session]))
  const { results } = indexToolResults(messages)
  const ordinal = new Map<string, number>()
  const delegations = new Map<string, Delegation>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!['spawn_subagent', 'continue_subagent'].includes(call.function.name)) continue
      const nodeId = toolNodeId(parentId, call.id, message.id)
      const result = results.get(nodeId)
      if (!result) continue
      const task = decodeTaskReferences(result.content)[0]
      const session = task && children.get(task.session_id)
      if (!task || !session || (task.parentSessionId && task.parentSessionId !== parentId)) continue
      if (result.status === 'error' && !['failed', 'aborted'].includes(task.status)) continue
      const index = ordinal.get(session.id) ?? 0
      const startupFailure = task.status === 'failed' && task.diagnostics?.failure?.stage === 'startup'
      if (!startupFailure) ordinal.set(session.id, index + 1)
      // Each delegated continuation writes a new user input. Independent later UI turns are not attached to this task.
      const turn = startupFailure ? undefined : splitConversationTurns(histories[session.id] ?? [])[index]
      delegations.set(nodeId, { callId: call.id, nodeId, task, session, turn })
    }
  }
  return delegations
}

export function messageNodeId(sessionId: string, messageId: string): string {
  return graphNodeId('message', sessionId, messageId)
}

export function toolNodeId(sessionId: string, callId: string, assistantMessageId: string): string {
  return graphNodeId('tool', sessionId, assistantMessageId, callId)
}

/** React Flow's dynamic port lookup interpolates node IDs into CSS selectors. Encode only the disposable graph key. */
const graphNodeIdCache = new Map<string, string>()
export function graphNodeId(...parts: string[]): string {
  const joined = parts.join('\u0000')
  const cached = graphNodeIdCache.get(joined)
  if (cached !== undefined) return cached
  const encoded = encodeURIComponent(JSON.stringify(parts))
  if (graphNodeIdCache.size > 50000) graphNodeIdCache.clear()
  graphNodeIdCache.set(joined, encoded)
  return encoded
}

/** Tool IDs can repeat in later rounds. Associate exact IDs only inside their declared assistant/tool group. */
export function indexToolResults(messages: readonly UIMessage[]): { results: Map<string, UIMessage>; mergedIds: Set<string> } {
  const results = new Map<string, UIMessage>()
  const mergedIds = new Set<string>()
  let group = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      group = new Map((message.toolCalls ?? []).map(call => [call.id, toolNodeId(message.sessionId, call.id, message.id)]))
    } else if (message.role === 'user' || message.role === 'system') group.clear()
    else if (message.role === 'tool' && message.toolCallId) {
      const key = group.get(message.toolCallId)
      if (key && !results.has(key)) { results.set(key, message); mergedIds.add(message.id) }
    }
  }
  return { results, mergedIds }
}
