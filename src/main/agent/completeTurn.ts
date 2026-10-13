import type { ChatMessage } from '../../shared/types.ts'
import { log } from '../llm/logger.ts'
import type { AgentEventCallbacks, RoundResult } from './eventCallbacks.ts'
import type { WorkingConversation } from './workingConversation.ts'
import { appendCoordinationMessages, type CoordinationMessage } from './runInbox.ts'
import { persistIncompleteToolRound } from './turnEffects.ts'
import { MAX_TRUNCATION_CONTINUATIONS } from './recoveryPolicy.ts'
import type { decideTurnOutcome } from './turnDecision.ts'

type CompleteDecision = Extract<ReturnType<typeof decideTurnOutcome>, { kind: 'complete' }>

/** Persist the current assistant before draining guidance. Rejected early finals stay real history, not fabricated tool calls. */
export function completeTurn(decision: CompleteDecision, result: RoundResult, round: number, state: {
  conversation: WorkingConversation
  allAssistantMessages: ChatMessage[]
  cb: AgentEventCallbacks
  takeCoordinationMessages?: (finalizing?: boolean) => CoordinationMessage[]
}): boolean {
  const { cb, conversation, allAssistantMessages } = state
  if (decision.truncatedNotice) {
    const cause = decision.cause || 'length'
    log('warn', `Round ${round}: incomplete output (${cause}) and ${MAX_TRUNCATION_CONTINUATIONS} continuations already used — finalizing`)
    if (result.toolCalls.length) persistIncompleteToolRound(result, cause, allAssistantMessages, cb)
    else { cb.onAssistantMessage?.(result.content, [], result.reasoning || undefined); cb.onTruncated?.('text', cause === 'stream' ? 'stream' : 'length') }
  } else {
    const id = cb.onAssistantMessage?.(result.content, result.toolCalls, result.reasoning || undefined) ?? null
    const messages = state.takeCoordinationMessages?.(true) ?? []
    if (messages.length) {
      const assistant: ChatMessage = { role: 'assistant', content: result.content || null }
      conversation.append(assistant, id); allAssistantMessages.push(assistant)
      appendCoordinationMessages(conversation, messages)
      return false
    }
  }
  log('info', `Agent completed after ${round} round(s)`)
  return true
}
