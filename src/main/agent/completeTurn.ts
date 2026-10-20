import type { ChatMessage } from '../../shared/types.ts'
import { log } from '../llm/logger.ts'
import type { AgentEventCallbacks, RoundResult } from './eventCallbacks.ts'
import type { WorkingConversation } from './workingConversation.ts'
import { appendCoordinationMessages, type CoordinationMessage } from './runInbox.ts'
import { persistIncompleteToolRound, persistUnexecutedToolRound } from './turnEffects.ts'
import { AgentCompletionError, type CompletionFailure } from './completionError.ts'
import { markGeneration, roundAssistant } from './roundOutput.ts'

/** Persist the current assistant before draining guidance. Rejected early finals stay real history, not fabricated tool calls. */
export function completeTurn(result: RoundResult, round: number, state: {
  conversation: WorkingConversation
  allAssistantMessages: ChatMessage[]
  cb: AgentEventCallbacks
  takeCoordinationMessages?: (finalizing?: boolean) => CoordinationMessage[]
}): boolean {
  const { cb, conversation, allAssistantMessages } = state
  const id = cb.onAssistantMessage?.(result.content, result.toolCalls, result.reasoning || undefined, result.generation) ?? null
  const assistant = roundAssistant(result)
  conversation.append(assistant, id)
  allAssistantMessages.push(assistant)
  const messages = state.takeCoordinationMessages?.(true) ?? []
  if (messages.length) {
    if (result.generation?.status === 'checking') {
      result.generation = markGeneration(result, 'unverified', 'New coordination input requires further work.')
      if (id) cb.onAssistantGeneration?.(id, result.generation)
    }
    appendCoordinationMessages(conversation, messages)
    return false
  }
  if (result.generation?.status !== 'checking') log('info', `Agent completed after ${round} round(s)`)
  return true
}

/** Keep the received history, close every rejected tool group, then let SessionService publish failure. */
export function failTurn(cause: CompletionFailure, result: RoundResult, allAssistantMessages: ChatMessage[],
  cb: AgentEventCallbacks, stage: 'response' | 'finalization' = 'response'): never {
  const error = new AgentCompletionError(cause, stage, result.refusal || result.generation?.reason
    || ((cause === 'refused' || cause === 'finish_reason') ? result.finishReason : undefined))
  result.generation = markGeneration(result, cause === 'refused' ? 'refused' : cause === 'unverified' ? 'unverified' : 'incomplete',
    result.generation?.reason || cause)
  if (result.toolCalls.length) {
    if (cause === 'length' || cause === 'stream' || cause === 'malformed') {
      persistIncompleteToolRound(result, cause, allAssistantMessages, cb)
    } else persistUnexecutedToolRound(result, error.message, allAssistantMessages, cb)
  } else {
    cb.onAssistantMessage?.(result.content || result.refusal || '', [], result.reasoning || undefined, result.generation)
    if (cause === 'length' || cause === 'stream') cb.onTruncated?.('text', cause)
  }
  throw error
}
