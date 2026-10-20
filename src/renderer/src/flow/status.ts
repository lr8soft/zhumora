import type { UIMessage } from '../../../shared/types.ts'
import { indexToolResults, toolNodeId, type TaskReference } from './history.ts'
import type { FlowStatus, FlowStep } from './types.ts'

/** A speech owns execution progress, but a tool's failure is not a failed LLM generation. */
export function speechStatus(steps: readonly FlowStep[]): FlowStatus {
  if (steps.some(step => step.data.kind === 'llm' && step.data.status === 'error')) return 'error'
  for (const status of ['running', 'queued', 'unresolved'] as const) {
    if (steps.some(step => step.data.status === status)) return status
  }
  return 'done'
}

/** A task snapshot describes this task ID; history alone can only establish a final reply or an unfinished run. */
export function turnStatus(messages: readonly UIMessage[], running = false, task?: TaskReference): FlowStatus {
  if (task?.status === 'completed') return 'done'
  if (task?.status === 'failed') return 'error'
  if (task?.status === 'aborted') return 'unresolved'
  if (running) return 'running'
  const last = [...messages].reverse().find(message => message.role === 'assistant')
  if (last?.status === 'error') return 'error'
  if (!last || (last.generation && last.generation.status !== 'complete') || last.toolCalls?.length || !last.content.trim()
    || (last.status !== undefined && last.status !== 'done')) return 'unresolved'
  const { results } = indexToolResults(messages)
  const pending = messages.some(message => message.toolCalls?.some(call =>
    !results.has(toolNodeId(message.sessionId, call.id, message.id))))
  return pending ? 'unresolved' : 'done'
}
