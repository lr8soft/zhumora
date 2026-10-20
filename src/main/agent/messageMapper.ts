import type { ChatMessage, UIMessage } from '../../shared/types'
import { buildUserContent } from '../../shared/multimodal.ts'

/** Translate persisted/UI records into the provider-facing message contract. */
export function mapPersistedHistory(history: UIMessage[]): { messages: ChatMessage[]; ids: string[] } {
  return {
    messages: history.map(message => ({
      role: message.role,
      content: message.role === 'user' && message.images?.length
        ? buildUserContent(message.content, message.images)
        : message.content,
      tool_calls: message.toolCalls,
      tool_call_id: message.toolCallId,
      name: message.toolName,
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      ...(message.generation?.providerId && message.generation.model ? { reasoningSource: {
        providerId: message.generation.providerId, model: message.generation.model } } : {})
    })),
    ids: history.map(message => message.id)
  }
}
