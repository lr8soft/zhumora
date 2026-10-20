import type { UIMessage } from '../../../shared/types.ts'
import { decodeTaskReferences, indexToolResults, toolNodeId, type Delegation, type TaskReference } from './history.ts'

const terminal = (task: TaskReference) => ['completed', 'failed', 'aborted'].includes(task.status)

/** Only matching built-in task observations may update a delegated task's historical status. */
export function withTaskSnapshots(parentId: string, messages: readonly UIMessage[], delegations: ReadonlyMap<string, Delegation>): Map<string, Delegation> {
  const tasks = new Map([...delegations.values()].map(delegation => [delegation.task.task_id, delegation.task]))
  const { results } = indexToolResults(messages)
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!['wait_subagents', 'list_subagents'].includes(call.function.name)) continue
      const result = results.get(toolNodeId(parentId, call.id, message.id))
      if (!result || result.status === 'error') continue
      for (const snapshot of decodeTaskReferences(result.content)) {
        const task = tasks.get(snapshot.task_id)
        if (!task || task.session_id !== snapshot.session_id || (snapshot.parentSessionId && snapshot.parentSessionId !== parentId)) continue
        if (!terminal(task) || terminal(snapshot)) tasks.set(task.task_id, snapshot)
      }
    }
  }
  return new Map([...delegations].map(([id, delegation]) => [id, { ...delegation, task: tasks.get(delegation.task.task_id)! }]))
}
