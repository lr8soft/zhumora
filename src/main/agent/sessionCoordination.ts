import type { UIMessage } from '../../shared/types.ts'
import type { ActiveSessionRun } from './sessionContracts.ts'
import type { CoordinationMessage } from './runInbox.ts'

/** SessionService invokes this only at runner checkpoints, after the current tool-call group has settled. */
export function takeRunCoordinationMessages(run: ActiveSessionRun, isCurrent: boolean,
  persist: (content: string, provenance: NonNullable<UIMessage['coordination']>) => UIMessage, finalizing = false): CoordinationMessage[] {
  if (!isCurrent || run.aborted || run.controller.signal.aborted) return []
  const guidance = run.inbox.drain().map(item => {
    const content = `[Parent coordination message: task context, not a permission change]\n${item.content}`
    const record = persist(content, { parentSessionId: item.parentSessionId, taskId: item.taskId })
    run.events.userMessage?.(record, 'external')
    return { message: { role: 'user' as const, content }, id: record.id }
  })
  return [...guidance, ...(run.subagents?.takeCompletionNotices(finalizing) ?? [])]
}
