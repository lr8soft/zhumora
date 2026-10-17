import type { ChatMessage } from '../../shared/types.ts'
import { log } from '../llm/logger.ts'
import type { AgentEventCallbacks, RoundResult } from './eventCallbacks.ts'
import type { WorkingConversation } from './workingConversation.ts'
import { appendCoordinationMessages, type CoordinationMessage } from './runInbox.ts'
import { persistIncompleteToolRound, persistUnexecutedToolRound } from './turnEffects.ts'
import { AgentCompletionError, type CompletionFailure } from './completionError.ts'

/** Persist the current assistant before draining guidance. Rejected early finals stay real history, not fabricated tool calls. */
export function completeTurn(result: RoundResult, round: number, state: {
  conversation: WorkingConversation
  allAssistantMessages: ChatMessage[]
  cb: AgentEventCallbacks
  takeCoordinationMessages?: (finalizing?: boolean) => CoordinationMessage[]
}): boolean {
  const { cb, conversation, allAssistantMessages } = state
  const id = cb.onAssistantMessage?.(result.content, result.toolCalls, result.reasoning || undefined) ?? null
  const assistant: ChatMessage = { role: 'assistant', content: result.content || null }
  conversation.append(assistant, id)
  allAssistantMessages.push(assistant)
  const messages = state.takeCoordinationMessages?.(true) ?? []
  if (messages.length) {
    appendCoordinationMessages(conversation, messages)
    return false
  }
  log('info', `Agent completed after ${round} round(s)`)
  return true
}

/** Keep the received history, close every rejected tool group, then let SessionService publish failure. */
export function failTurn(cause: CompletionFailure, result: RoundResult, allAssistantMessages: ChatMessage[],
  cb: AgentEventCallbacks, stage: 'response' | 'finalization' = 'response'): never {
  const error = new AgentCompletionError(cause, stage)
  if (result.toolCalls.length) {
    if (cause === 'length' || cause === 'stream' || cause === 'malformed') {
      persistIncompleteToolRound(result, cause, allAssistantMessages, cb)
    } else persistUnexecutedToolRound(result, error.message, allAssistantMessages, cb)
  } else {
    cb.onAssistantMessage?.(result.content, [], result.reasoning || undefined)
    if (cause === 'length' || cause === 'stream') cb.onTruncated?.('text', cause)
  }
  throw error
}
