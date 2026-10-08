import type { ActiveSessionRun, SessionStore } from './sessionContracts.ts'
import { createPersistedAgentCallbacks } from './persistedCallbacks.ts'
import type { AgentEventCallbacks } from './eventCallbacks.ts'

/** Persistence can finish before the run tree. Only SessionService publishes its terminal outcome. */
export function createSessionRunCallbacks(
  sessionId: string, run: ActiveSessionRun, store: SessionStore, nextMessageId: () => string, isCurrent: () => boolean
): AgentEventCallbacks {
  return createPersistedAgentCallbacks(sessionId, store, nextMessageId, {
    ...run.events,
    complete: (_sessionId, messageId, content) => { run.outcome = { kind: 'completed', messageId, content } },
    error: (_sessionId, error) => { run.outcome = { kind: 'failed', error } }
  }, isCurrent)
}

export function publishRunOutcome(sessionId: string, run: ActiveSessionRun): void {
  if (run.aborted) return
  if (run.outcome?.kind === 'completed') run.events.complete?.(sessionId, run.outcome.messageId, run.outcome.content)
  else if (run.outcome?.kind === 'failed') run.events.error?.(sessionId, run.outcome.error)
}
