import { AgentAbortedError, type ChatMessage } from '../../shared/types.ts'
import type { StreamCallbacks } from '../llm/provider.ts'
import type { AgentEventCallbacks, RoundResult } from './eventCallbacks.ts'
import type { WorkingConversation } from './workingConversation.ts'
import { persistUnexecutedToolRound } from './turnEffects.ts'
import { roundAssistant } from './roundOutput.ts'

/** One logical request may have several visible attempts, each with its own authoritative message. */
export function createRoundStreamCallbacks(state: {
  conversation: WorkingConversation
  allAssistantMessages: ChatMessage[]
  cb: AgentEventCallbacks
  model: string
  signal?: AbortSignal
  prepareRetry?: () => Promise<void>
}): StreamCallbacks {
  const { conversation, allAssistantMessages, cb } = state
  return {
    onToken: cb.onToken,
    onReasoningToken: cb.onReasoningToken,
    onRetry: cb.onRetry,
    // Terminal errors belong to SessionService. A temporary failure must never
    // publish a permanent error or close the run before its retry budget settles.
    onInterruptedAttempt: async (partial, error, willRetry) => {
      const result: RoundResult = { ...partial, content: partial.content || partial.refusal || '', generation: {
        version: 1, ...partial.generation, status: 'incomplete',
        reason: partial.refusal ? `${error.message}\nProvider refusal: ${partial.refusal}` : error.message
      }, finishReason: partial.finishReason, usage: partial.usage }
      if (partial.usage) cb.onTokenUsage?.(partial.usage, state.model)
      if (result.toolCalls.length) {
        persistUnexecutedToolRound(result, '[Provider response interrupted] This tool call was not executed. '
          + 'Continue from the preserved results and issue any unfinished call again.', allAssistantMessages, cb)
      } else {
        const id = cb.onAssistantMessage?.(result.content, [], result.reasoning || undefined, result.generation) ?? null
        if (result.content) {
          const assistant = roundAssistant(result)
          conversation.append(assistant, id)
          allAssistantMessages.push(assistant)
        }
      }
      if (state.signal?.aborted) throw new AgentAbortedError()
      if (!willRetry) return conversation.messages
      conversation.appendSyntheticUser('[System notice] The provider failed while generating the previous response. '
        + 'Continue only the unfinished response or work from the current state. '
        + 'Preserve completed tool results and do not repeat completed actions.')
      await state.prepareRetry?.()
      return conversation.messages
    }
  }
}
