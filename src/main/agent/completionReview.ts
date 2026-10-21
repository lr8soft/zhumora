import type { ChatMessage, ProviderConfig } from '../../shared/types.ts'
import { AgentAbortedError } from '../../shared/types.ts'
import { streamChat } from '../llm/provider.ts'
import { buildCompletionReviewInput } from './completionReviewInput.ts'
import type { RoundResult, AgentEventCallbacks } from './eventCallbacks.ts'
import type { WorkingConversation } from './workingConversation.ts'
import type { RecoveryBudget } from './recoveryPolicy.ts'
import { markGeneration } from './roundOutput.ts'
import { AgentCompletionError } from './completionError.ts'
import type { ReasoningEffortParam } from '../llm/reasoning.ts'

interface Review { decision: 'final' | 'continue' | 'uncertain'; reason: string }

/** Control output is neither an assistant reply nor authority to execute a tool. */
export function parseCompletionReview(text: string): Review {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object') throw new Error('Invalid completion review')
  const review = value as Review
  if (!['final', 'continue', 'uncertain'].includes(review.decision) || typeof review.reason !== 'string' || !review.reason.trim()) {
    throw new Error('Invalid completion review: ' + text)
  }
  return review
}

export function shouldReviewCompletion(provider: ProviderConfig, toolsAvailable: boolean, messages: ChatMessage[]): boolean {
  return provider.completionReview !== false && (toolsAvailable || messages.some(message => message.role === 'tool'))
}

export async function checkFinalCandidate(result: RoundResult, state: {
  provider: ProviderConfig; model: string; goal: string; contextWindow: number; signal?: AbortSignal
  conversation: WorkingConversation; cb: AgentEventCallbacks; recovery: RecoveryBudget
  toolsAvailable: boolean
  reasoningEffort?: ReasoningEffortParam
  candidateId: string | null
}): Promise<boolean> {
  if (!shouldReviewCompletion(state.provider, state.toolsAvailable, state.conversation.messages)) return true
  const publish = () => {
    if (state.candidateId && result.generation) state.cb.onAssistantGeneration?.(state.candidateId, result.generation)
  }
  let review: Review
  try {
    if (!state.recovery.takeReview()) throw new Error('Completion review budget exhausted')
    const { messages, maxTokens } = buildCompletionReviewInput(state.goal, result.content,
      state.conversation.messages, state.contextWindow)
    const response = await streamChat(state.provider, { messages, model: state.model, maxTokens,
      purpose: 'review', reasoningEffort: result.reasoningDowngraded ? undefined : state.reasoningEffort,
      retryOnlyRateLimit: true, requestTimeoutMs: 60_000, signal: state.signal },
      { onRetry: state.cb.onRetry })
    if (response.usage) state.cb.onTokenUsage?.(response.usage, state.model)
    if (state.signal?.aborted) throw new AgentAbortedError()
    if (response.finishReason !== 'stop' || response.streamInterrupted || response.toolCalls.length || response.refusal) {
      throw new Error('Incomplete completion review: ' + JSON.stringify(response))
    }
    review = parseCompletionReview(response.content)
  } catch (error) {
    result.generation = markGeneration(result, 'unverified', (error as Error).message)
    publish()
    if (state.signal?.aborted || error instanceof AgentAbortedError) {
      throw new AgentAbortedError()
    }
    throw new AgentCompletionError('unverified', 'response', (error as Error).message)
  }
  result.generation = markGeneration(result, review.decision === 'final' ? 'complete' : 'unverified', review.reason)
  publish()
  if (review.decision === 'final') {
    // 发布判定会同步通知 UI；用户可能恰好在这一刻停止运行。中止优先于成功：
    // 候选降级为未验证后再传播中止，不能随后发布 running=false 的成功收尾。
    if (state.signal?.aborted) {
      result.generation = markGeneration(result, 'unverified', 'Run aborted before the final result was published.')
      publish()
      throw new AgentAbortedError()
    }
    return true
  }
  if (review.decision !== 'continue' || !state.recovery.takeSemanticContinuation()) {
    throw new AgentCompletionError('unverified', 'response', review.reason)
  }
  state.conversation.appendSyntheticUser('[System notice] Completion review found the response incomplete: '
    + review.reason + '\nContinue the unfinished response/work from the current state. Do not repeat completed tool actions.')
  return false
}
