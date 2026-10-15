import { AgentAbortedError, type ChatMessage, type ProviderConfig } from '../../shared/types'
import { streamChat } from '../llm/provider'
import type { ReasoningEffortParam } from '../llm/reasoning'
import { log } from '../llm/logger'
import type { WorkingConversation } from './workingConversation'
import type { AutoCompactor } from './autoCompact'
import type { AgentEventCallbacks } from './eventCallbacks'
import { ContextBudgetExceededError } from './contextBudget'

/**
 * 停止时的优雅收尾（达到轮数上限 / 循环硬停）
 * 追加一条收尾指令后发起一次不带 tools 的调用，强制模型纯文本输出：
 * 已完成什么、剩下什么、关键文件路径。收尾调用失败不影响主流程。
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
    const { content, usage } = await streamChat(provider, {
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
      // 收尾失败不覆盖主流程错误状态、不触发重试 UI
      onError: undefined,
      onRetry: undefined
    })
    if (usage) cb.onTokenUsage?.(usage, model)
    if (signal?.aborted) throw new AgentAbortedError()
    // 理论上无 tools 不会产生 tool_calls；若个别模型仍返回，丢弃（不入库，避免悬空）
    const msg: ChatMessage = { role: 'assistant', content: content || null }
    conversation.append(msg, null)
    allAssistantMessages.push(msg)
    cb.onAssistantMessage?.(content, [], roundReasoning || undefined)
    log('info', 'Finalize summary completed')
  } catch (err) {
    // Never turn budget rejection or user cancellation into a successful completion.
    if (signal?.aborted || err instanceof AgentAbortedError) throw new AgentAbortedError()
    if (err instanceof ContextBudgetExceededError) throw err
    log('error', `Finalize summary failed: ${(err as Error).message}`)
  }
}

