import { AgentAbortedError, type ChatMessage, type ProviderConfig } from '../../shared/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { streamChat } from '../llm/provider.ts'
import type { ReasoningEffortParam } from '../llm/reasoning.ts'
import type { WorkingConversation } from './workingConversation.ts'
import type { AgentEventCallbacks, RoundResult } from './eventCallbacks.ts'
import { createRoundStreamCallbacks } from './streamCallbacks.ts'

/** 发起一轮 LLM 流式调用，聚合 token 回调与本轮思考内容 */
export async function streamAgentRound(
  conversation: WorkingConversation,
  provider: ProviderConfig,
  modelOverride: string | undefined,
  reasoningEffort: ReasoningEffortParam | undefined,
  tools: ReturnType<ToolRegistry['definitions']>,
  signal: AbortSignal | undefined,
  cb: AgentEventCallbacks,
  allAssistantMessages: ChatMessage[] = [],
  prepareRetry?: () => Promise<void>
): Promise<RoundResult> {
  const model = modelOverride || provider.defaultModel
  try {
    const result = await streamChat(provider, {
      messages: conversation.messages,
      tools: tools.length > 0 ? tools : undefined,
      toolChoice: 'auto',
      model,
      temperature: provider.temperature,
      reasoningEffort,
      signal
    }, createRoundStreamCallbacks({ conversation, allAssistantMessages, cb, model, signal, prepareRetry }))
    return { ...result, usage: result.usage, finishReason: result.finishReason }
  } catch (error) {
    if (signal?.aborted) throw new AgentAbortedError()
    throw error
  }
}

