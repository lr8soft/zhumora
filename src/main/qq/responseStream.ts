import type { ToolCall } from '../../shared/types'
import type { AgentEventSink } from '../agent/persistedCallbacks'
import { log } from '../llm/logger.ts'
import type { QQClient, QQMessageTarget, QQTextStream } from './client'
import { formatBotToolCall } from '../bot/progress.ts'

interface RoundStream {
  stream: QQTextStream
  content: string
  reasoning: string
  failed: boolean
}

/** Maps Agent events to QQ C2C streams and immediate progress messages. */
export class QQResponseStream {
  readonly events: AgentEventSink
  private readonly rounds = new Map<string, RoundStream>()
  private readonly groupReasoningStarted = new Set<string>()
  private delivery = Promise.resolve()
  private readonly client: QQClient
  private readonly target: QQMessageTarget

  constructor(
    client: QQClient,
    target: QQMessageTarget
  ) {
    this.client = client
    this.target = target
    this.events = {
      token: (_sessionId, messageId, token) => this.onToken(messageId, token),
      reasoning: (_sessionId, messageId, token) => this.onReasoning(messageId, token),
      toolCall: (_sessionId, _messageId, toolCall) => this.onToolCall(toolCall),
      toolResult: (_message, _toolCallId, toolName, _result, isError, durationMs) =>
        this.onToolResult(toolName, isError, durationMs),
      assistantEnd: (_sessionId, messageId, content) => this.onAssistantEnd(messageId, content)
    }
  }

  async flush(): Promise<void> {
    for (const round of this.rounds.values()) {
      if (round.failed) {
        const fallback = round.content || (round.reasoning ? `💭 ${round.reasoning}` : '')
        if (fallback) this.enqueue(() => this.client.sendText(this.target, fallback))
      } else if (round.content || round.reasoning) this.enqueue(() => round.stream.complete())
      else round.stream.cancel()
    }
    this.rounds.clear()
    await this.delivery
  }

  private onToken(messageId: string, token: string): void {
    if (!messageId || this.target.scope !== 'c2c') return
    const round = this.ensureRound(messageId)
    round.content += token
    this.enqueue(() => round.stream.update(round.content), () => {
      round.failed = true
      round.stream.cancel()
    })
  }

  private onReasoning(messageId: string, token: string): void {
    if (!messageId) return
    if (this.target.scope !== 'c2c') {
      if (!this.groupReasoningStarted.has(messageId)) {
        this.groupReasoningStarted.add(messageId)
        this.enqueue(() => this.client.sendText(this.target, '💭 思考中…'))
      }
      return
    }
    const round = this.ensureRound(messageId)
    round.reasoning += token
    if (!round.content) this.enqueue(() => round.stream.update(`💭 ${round.reasoning}`), () => {
      round.failed = true
      round.stream.cancel()
    })
  }

  private onToolCall(toolCall: ToolCall): void {
    this.enqueue(() => this.client.sendText(this.target, `🔧 ${formatBotToolCall(toolCall)}`))
  }

  private onToolResult(toolName: string, isError: boolean, durationMs: number): void {
    const status = isError ? '❌ 失败' : '✅ 完成'
    this.enqueue(() => this.client.sendText(this.target, `${status} · ${toolName} · ${formatDuration(durationMs)}`))
  }

  private onAssistantEnd(messageId: string, content: string): void {
    this.groupReasoningStarted.delete(messageId)
    const round = this.rounds.get(messageId)
    if (round) {
      this.rounds.delete(messageId)
      if (content.trim()) {
        round.content = content
        this.enqueue(async () => {
          if (round.failed) return this.client.sendText(this.target, content)
          try {
            await round.stream.update(content)
            await round.stream.complete()
          } catch (error) {
            round.failed = true
            round.stream.cancel()
            log('warn', `QQ native stream failed; falling back to text: ${safeError(error)}`)
            await this.client.sendText(this.target, content)
          }
        })
      } else if (round.reasoning) {
        this.enqueue(() => round.failed
          ? this.client.sendText(this.target, `💭 ${round.reasoning}`)
          : round.stream.complete())
      } else {
        round.stream.cancel()
      }
      return
    }
    if (content.trim()) this.enqueue(() => this.client.sendText(this.target, content))
  }

  private ensureRound(messageId: string): RoundStream {
    let round = this.rounds.get(messageId)
    if (!round) {
      round = { stream: this.client.openStream(this.target), content: '', reasoning: '', failed: false }
      this.rounds.set(messageId, round)
    }
    return round
  }

  private enqueue(task: () => Promise<unknown>, onError?: () => void): void {
    this.delivery = this.delivery.then(task).then(() => undefined).catch(error => {
      onError?.()
      log('warn', `QQ response delivery failed: ${safeError(error)}`)
    })
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}
