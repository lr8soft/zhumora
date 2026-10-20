import type { ChatMessage } from '../../shared/types.ts'
import type { GenerationMetadata } from '../../shared/generation.ts'
import type { RoundResult } from './eventCallbacks.ts'

export function markGeneration(result: RoundResult, status: GenerationMetadata['status'], reason?: string): GenerationMetadata {
  return { version: 1, ...result.generation, status, ...(reason ? { reason } : {}) }
}

export function roundAssistant(result: RoundResult): ChatMessage {
  return { role: 'assistant', content: result.content || null,
    ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
    ...(result.reasoning && result.generation?.reasoningReplay ? { reasoning: result.reasoning } : {}),
    ...(result.reasoning && result.generation?.reasoningReplay && result.generation.providerId && result.generation.model ? { reasoningSource: {
      providerId: result.generation.providerId, model: result.generation.model } } : {}) }
}
