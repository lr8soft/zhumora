import type { ChatMessage, ToolCall } from './types'

/**
 * OpenAI-compatible backends expect function.arguments to be a serialized JSON
 * object. A truncated stream can still leave a ToolCall-shaped value whose
 * arguments string is incomplete, so structural typing alone is insufficient.
 */
export function isValidToolCall(call: ToolCall): boolean {
  if (!call || typeof call !== 'object') return false
  if (!call.id || call.type !== 'function' || !call.function?.name) return false
  if (typeof call.function.arguments !== 'string') return false
  try {
    const value = JSON.parse(call.function.arguments)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

/** True when every assistant tool call is safe to replay to a provider. */
export function hasValidToolCalls(message: ChatMessage): boolean {
  return !message.tool_calls?.length || message.tool_calls.every(isValidToolCall)
}
