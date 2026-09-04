import type { ToolCall, UIMessage } from '../../shared/types'
import type { TokenUsage } from '../llm/provider'
import type { AgentEventCallbacks } from './eventCallbacks'

export interface AgentEventSink {
  userMessage?(message: UIMessage): void
  assistantStart?(sessionId: string, messageId: string): void
  token?(sessionId: string, messageId: string, token: string): void
  reasoning?(sessionId: string, messageId: string, token: string): void
  toolCall?(sessionId: string, messageId: string | null, toolCall: ToolCall): void
  toolResult?(message: UIMessage, toolCallId: string, toolName: string, result: string, isError: boolean, durationMs: number): void
  assistantEnd?(sessionId: string, messageId: string, content: string, toolCalls: ToolCall[], reasoning?: string): void
  complete?(sessionId: string, messageId: string, content: string): void
  error?(sessionId: string, error: Error): void
  retry?(sessionId: string, failedAttempt: number, maxRetries: number, error: Error): void
  truncated?(sessionId: string, kind: 'tool' | 'text'): void
  compact?(sessionId: string, info: { beforeTokens: number; afterTokens: number; compressedCount: number; keptCount: number; boundaryMessageId?: string }): void
}

export interface AgentPersistence {
  addMessage(message: UIMessage): void
  addTokenUsage(model: string, inputTokens: number, outputTokens: number, createdAt: number): void
}

export function combineAgentEventSinks(...sinks: AgentEventSink[]): AgentEventSink {
  return {
    userMessage: message => sinks.forEach(sink => sink.userMessage?.(message)),
    assistantStart: (sessionId, messageId) => sinks.forEach(sink => sink.assistantStart?.(sessionId, messageId)),
    token: (sessionId, messageId, token) => sinks.forEach(sink => sink.token?.(sessionId, messageId, token)),
    reasoning: (sessionId, messageId, token) => sinks.forEach(sink => sink.reasoning?.(sessionId, messageId, token)),
    toolCall: (sessionId, messageId, toolCall) => sinks.forEach(sink => sink.toolCall?.(sessionId, messageId, toolCall)),
    toolResult: (message, toolCallId, toolName, result, isError, durationMs) =>
      sinks.forEach(sink => sink.toolResult?.(message, toolCallId, toolName, result, isError, durationMs)),
    assistantEnd: (sessionId, messageId, content, toolCalls, reasoning) =>
      sinks.forEach(sink => sink.assistantEnd?.(sessionId, messageId, content, toolCalls, reasoning)),
    complete: (sessionId, messageId, content) => sinks.forEach(sink => sink.complete?.(sessionId, messageId, content)),
    error: (sessionId, error) => sinks.forEach(sink => sink.error?.(sessionId, error)),
    retry: (sessionId, failedAttempt, maxRetries, error) =>
      sinks.forEach(sink => sink.retry?.(sessionId, failedAttempt, maxRetries, error)),
    truncated: (sessionId, kind) => sinks.forEach(sink => sink.truncated?.(sessionId, kind)),
    compact: (sessionId, info) => sinks.forEach(sink => sink.compact?.(sessionId, info))
  }
}

export function createPersistedAgentCallbacks(
  sessionId: string,
  persistence: AgentPersistence,
  generateId: () => string,
  events: AgentEventSink
): AgentEventCallbacks {
  let streamingMsgId: string | null = null
  let streamingContent = ''
  let streamingReasoning = ''
  let roundMsgId: string | null = null
  let roundReasoning = ''
  let errorHandled = false

  const ensureRoundMsgId = (): string => {
    if (!roundMsgId) {
      roundMsgId = generateId()
      events.assistantStart?.(sessionId, roundMsgId)
    }
    return roundMsgId
  }

  return {
    onToken: token => {
      streamingContent += token
      events.token?.(sessionId, ensureRoundMsgId(), token)
    },
    onReasoningToken: token => {
      roundReasoning += token
      streamingReasoning = roundReasoning
      events.reasoning?.(sessionId, ensureRoundMsgId(), token)
    },
    onToolCall: (toolCall, assistantMessageId) => {
      events.toolCall?.(sessionId, assistantMessageId, toolCall)
    },
    onToolResult: (toolCallId, toolName, result, isError, durationMs) => {
      const message: UIMessage = {
        id: generateId(), sessionId, role: 'tool', content: result, toolCallId, toolName,
        timestamp: Date.now(), status: isError ? 'error' : 'done'
      }
      persistence.addMessage(message)
      events.toolResult?.(message, toolCallId, toolName, result, isError, durationMs)
      return message.id
    },
    onAssistantMessage: (content, toolCalls, reasoning) => {
      let persistedId: string | null = null
      if (content || toolCalls.length > 0 || reasoning) {
        const messageId = ensureRoundMsgId()
        persistence.addMessage({
          id: messageId,
          sessionId,
          role: 'assistant',
          content: content || '',
          reasoning: reasoning || roundReasoning || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: Date.now(),
          status: 'done'
        })
        persistedId = messageId
      }
      streamingMsgId = roundMsgId
      streamingContent = content || ''
      streamingReasoning = reasoning || roundReasoning || ''
      roundMsgId = null
      roundReasoning = ''
      events.assistantEnd?.(
        sessionId,
        streamingMsgId || '',
        content,
        toolCalls,
        streamingReasoning || undefined
      )
      return persistedId
    },
    onTokenUsage: (usage: TokenUsage, model: string) => {
      persistence.addTokenUsage(model, usage.prompt_tokens, usage.completion_tokens, Date.now())
    },
    onComplete: () => {
      if (!streamingMsgId) {
        const messageId = generateId()
        persistence.addMessage({
          id: messageId,
          sessionId,
          role: 'assistant',
          content: streamingContent || '',
          reasoning: streamingReasoning || undefined,
          timestamp: Date.now(),
          status: 'done'
        })
        streamingMsgId = messageId
      }
      events.complete?.(sessionId, streamingMsgId || '', streamingContent)
    },
    onError: error => {
      if (errorHandled) return
      errorHandled = true
      const errorText = `Error: ${error.message}`
      if (roundMsgId) {
        persistence.addMessage({
          id: roundMsgId,
          sessionId,
          role: 'assistant',
          content: streamingContent ? `${streamingContent}\n\n${errorText}` : errorText,
          reasoning: roundReasoning || undefined,
          timestamp: Date.now(),
          status: 'error'
        })
      } else if (!streamingMsgId) {
        persistence.addMessage({
          id: generateId(), sessionId, role: 'assistant', content: errorText,
          timestamp: Date.now(), status: 'error'
        })
      }
      events.error?.(sessionId, error)
    },
    onRetry: (failedAttempt, maxRetries, error) => {
      events.retry?.(sessionId, failedAttempt, maxRetries, error)
    },
    onTruncated: kind => events.truncated?.(sessionId, kind),
    onCompact: info => events.compact?.(sessionId, info)
  }
}
