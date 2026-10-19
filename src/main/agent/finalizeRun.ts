import { AgentAbortedError, type ChatMessage, type ProviderConfig } from '../../shared/types'
import { streamChat } from '../llm/provider'
import type { ReasoningEffortParam } from '../llm/reasoning'
import { log } from '../llm/logger'
import type { WorkingConversation } from './workingConversation'
import type { AutoCompactor } from './autoCompact'
import type { AgentEventCallbacks } from './eventCallbacks'
import { finalizationFailure } from './turnDecision'
import { failTurn } from './completeTurn'

/**
 * 停止时的优雅收尾（达到轮数上限 / 循环硬停）
 * 追加一条收尾指令后发起一次不带 tools 的调用，强制模型纯文本输出：
 * 已完成什么、剩下什么、关键文件路径。任何无效收尾必须沿原错误链传播。
 */
export async function finalizeRun(
  provider: ProviderConfig,
  modelOverride: string | undefined,
  signal: AbortSignal | undefined,
  reason: string,
  conversation: WorkingConversation,
  allAssistantMessages: ChatMessage[],
  cb: AgentEventCallbacks,
  reasoningEffort: ReasoningEffortParam | undefined,
  compactor: AutoCompactor
): Promise<void> {
  conversation.appendSyntheticUser(`[System notice] The agent run has been stopped: ${reason}. You must now respond with text only — do NOT call any tools. In 1-3 short paragraphs, summarize: (1) what has been accomplished so far, (2) what remains to be done, (3) any important file paths or decisions. Be concrete and actionable so the user can continue in the next message.`)
  try {
    await compactor.applyIfOverThreshold(conversation, 'before finalization')
    if (signal?.aborted) throw new AgentAbortedError()
    const model = modelOverride || provider.defaultModel
    let roundReasoning = ''
    const result = await streamChat(provider, {
      messages: conversation.messages,
      tools: undefined,   // 无 tools → 强制纯文本
      model,
      temperature: provider.temperature,
      reasoningEffort,
      signal
    }, {
      onToken: cb.onToken,
      onReasoningToken: (t) => {
        roundReasoning += t
        cb.onReasoningToken?.(t)
      },
      // 错误由 SessionService 统一发布，不在此处重复触发。
      onError: undefined,
      onRetry: cb.onRetry
    })
    const { content, usage } = result
    if (usage) cb.onTokenUsage?.(usage, model)
    if (signal?.aborted) {
      if (content || roundReasoning) cb.onAssistantMessage?.(content, [], roundReasoning || undefined)
      throw new AgentAbortedError()
    }
    const failure = finalizationFailure({ finishReason: result.finishReason, streamInterrupted: result.streamInterrupted,
      toolCallCount: result.toolCalls.length, contentEmpty: !content.trim() })
    if (failure) failTurn(failure, { ...result, usage, finishReason: result.finishReason, reasoning: roundReasoning },
      allAssistantMessages, cb, 'finalization')
    const msg: ChatMessage = { role: 'assistant', content: content || null }
    const id = cb.onAssistantMessage?.(content, [], roundReasoning || undefined) ?? null
    conversation.append(msg, id)
    allAssistantMessages.push(msg)
    log('info', 'Finalize summary completed')
  } catch (err) {
    // Never turn budget rejection or user cancellation into a successful completion.
    if (signal?.aborted || err instanceof AgentAbortedError) throw new AgentAbortedError()
    log('error', `Finalize summary failed: ${(err as Error).message}`)
    throw err
  }
}

