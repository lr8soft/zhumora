import type { ToolCall, UIMessage } from '../../shared/types'
import type { AgentEventCallbacks } from './eventCallbacks'

export interface AgentEventSink {
  running?(sessionId: string, running: boolean): void
  aborted?(sessionId: string): void
  titleUpdated?(sessionId: string, title: string): void
  userMessage?(message: UIMessage, source: 'renderer' | 'external'): void
  assistantStart?(sessionId: string, messageId: string): void
  token?(sessionId: string, messageId: string, token: string): void
  reasoning?(sessionId: string, messageId: string, token: string): void
  toolCall?(sessionId: string, messageId: string | null, toolCall: ToolCall): void
  toolResult?(message: UIMessage, toolCallId: string, toolName: string, result: string, isError: boolean, durationMs: number): void
  assistantEnd?(sessionId: string, messageId: string, content: string, toolCalls: ToolCall[], reasoning?: string): void
  complete?(sessionId: string, messageId: string, content: string): void
  error?(sessionId: string, error: Error): void
  retry?(sessionId: string, failedAttempt: number, maxRetries: number, error: Error): void
  truncated?(sessionId: string, kind: 'tool' | 'text', reason: 'length' | 'stream'): void
  compact?(sessionId: string, info: { source: 'auto' | 'manual'; beforeTokens: number; afterTokens: number; compressedCount: number; keptCount: number; boundaryMessageId?: string }): void
}

export interface AgentPersistence {
  addMessage(message: UIMessage): void
  addTokenUsage(model: string, inputTokens: number, outputTokens: number, createdAt: number): void
}

export function combineAgentEventSinks(...sinks: AgentEventSink[]): AgentEventSink {
  return {
    running: (sessionId, running) => sinks.forEach(sink => sink.running?.(sessionId, running)),
    aborted: sessionId => sinks.forEach(sink => sink.aborted?.(sessionId)),
    titleUpdated: (sessionId, title) => sinks.forEach(sink => sink.titleUpdated?.(sessionId, title)),
    userMessage: (message, source) => sinks.forEach(sink => sink.userMessage?.(message, source)),
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
    truncated: (sessionId, kind, reason) => sinks.forEach(sink => sink.truncated?.(sessionId, kind, reason)),
    compact: (sessionId, info) => sinks.forEach(sink => sink.compact?.(sessionId, info))
  }
}

export function createPersistedAgentCallbacks(
  sessionId: string,
  persistence: AgentPersistence,
  generateId: () => string,
  events: AgentEventSink,
  isCurrent: () => boolean = () => true
): AgentEventCallbacks {
  const messages = new PersistedAgentMessages({ sessionId, persistence, generateId, events })
  return {
    onToken: token => { if (isCurrent()) messages.token(token) },
    onReasoningToken: token => { if (isCurrent()) messages.reasoning(token) },
    onToolCall: (toolCall, assistantMessageId) => {
      if (isCurrent()) events.toolCall?.(sessionId, assistantMessageId, toolCall)
    },
    onToolResult: (toolCallId, toolName, result, isError, durationMs) => isCurrent()
      ? messages.toolResult(toolCallId, toolName, result, isError, durationMs) : null,
    onAssistantMessage: (content, toolCalls, reasoning) => isCurrent() ? messages.assistant(content, toolCalls, reasoning) : null,
    onTokenUsage: (usage, model) => {
      if (isCurrent()) persistence.addTokenUsage(model, usage.prompt_tokens, usage.completion_tokens, Date.now())
    },
    onComplete: () => { if (isCurrent()) messages.complete() },
    onError: error => { if (isCurrent()) messages.error(error) },
    onRetry: (failedAttempt, maxRetries, error) => {
      if (isCurrent()) events.retry?.(sessionId, failedAttempt, maxRetries, error)
    },
    onTruncated: (kind, reason) => { if (isCurrent()) events.truncated?.(sessionId, kind, reason) },
    onCompact: info => { if (isCurrent()) events.compact?.(sessionId, { source: 'auto', ...info }) }
  }
}

interface MessageContext {
  sessionId: string
  persistence: AgentPersistence
  generateId: () => string
  events: AgentEventSink
}

/** One run's authoritative message IDs and streaming-round state. No lifecycle or run ownership. */
class PersistedAgentMessages {
  private streamingMsgId: string | null = null
  private streamingContent = ''
  private streamingReasoning = ''
  private roundMsgId: string | null = null
  private roundReasoning = ''
  private errorHandled = false
  private readonly context: MessageContext

  constructor(context: MessageContext) { this.context = context }

  token(token: string): void {
    this.streamingContent += token
    this.context.events.token?.(this.context.sessionId, this.ensureRoundId(), token)
  }

  reasoning(token: string): void {
    this.roundReasoning += token
    this.streamingReasoning = this.roundReasoning
    this.context.events.reasoning?.(this.context.sessionId, this.ensureRoundId(), token)
  }

  toolResult(toolCallId: string, toolName: string, content: string, isError: boolean, durationMs: number): string {
    const message: UIMessage = {
      id: this.context.generateId(), sessionId: this.context.sessionId, role: 'tool', content, toolCallId, toolName,
      timestamp: Date.now(), status: isError ? 'error' : 'done'
    }
    this.context.persistence.addMessage(message)
    this.context.events.toolResult?.(message, toolCallId, toolName, content, isError, durationMs)
    return message.id
  }

  assistant(content: string, toolCalls: ToolCall[], reasoning?: string): string | null {
    let id: string | null = null
    if (content || toolCalls.length || reasoning) {
      id = this.ensureRoundId()
      this.context.persistence.addMessage({
        id, sessionId: this.context.sessionId, role: 'assistant', content: content || '',
        reasoning: reasoning || this.roundReasoning || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined, timestamp: Date.now(), status: 'done'
      })
    }
    this.streamingMsgId = this.roundMsgId
    this.streamingContent = content || ''
    this.streamingReasoning = reasoning || this.roundReasoning || ''
    this.roundMsgId = null
    this.roundReasoning = ''
    this.context.events.assistantEnd?.(this.context.sessionId, this.streamingMsgId || '', content, toolCalls,
      this.streamingReasoning || undefined)
    return id
  }

  complete(): void {
    if (!this.streamingMsgId) {
      this.streamingMsgId = this.context.generateId()
      this.context.persistence.addMessage({
        id: this.streamingMsgId, sessionId: this.context.sessionId, role: 'assistant', content: this.streamingContent || '',
        reasoning: this.streamingReasoning || undefined, timestamp: Date.now(), status: 'done'
      })
    }
    this.context.events.complete?.(this.context.sessionId, this.streamingMsgId, this.streamingContent)
  }

  error(error: Error): void {
    if (this.errorHandled) return
    this.errorHandled = true
    const errorText = `Error: ${error.message}`
    if (this.roundMsgId) {
      this.context.persistence.addMessage({
        id: this.roundMsgId, sessionId: this.context.sessionId, role: 'assistant',
        content: this.streamingContent ? `${this.streamingContent}\n\n${errorText}` : errorText,
        reasoning: this.roundReasoning || undefined, timestamp: Date.now(), status: 'error'
      })
    } else if (!this.streamingMsgId) {
      this.context.persistence.addMessage({
        id: this.context.generateId(), sessionId: this.context.sessionId, role: 'assistant', content: errorText,
        timestamp: Date.now(), status: 'error'
      })
    }
    this.context.events.error?.(this.context.sessionId, error)
  }

  private ensureRoundId(): string {
    if (!this.roundMsgId) {
      this.roundMsgId = this.context.generateId()
      this.context.events.assistantStart?.(this.context.sessionId, this.roundMsgId)
    }
    return this.roundMsgId
  }
}
