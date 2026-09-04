import type { ToolCall } from '../../shared/types'
import type { AgentEventSink } from '../agent/persistedCallbacks'
import { log } from '../llm/logger.ts'
import { formatBotToolCall } from '../bot/progress.ts'
import type { TelegramHttpClient, TelegramMessage } from './client'

const DRAFT_INTERVAL_MS = 700
const DRAFT_TEXT_LIMIT = 4000

interface DraftState {
  draftId: number
  text: string
  timer: ReturnType<typeof setTimeout> | null
}

interface ToolProgressState {
  messageId: number
  label: string
}

/** Telegram delivery adapter: throttled drafts plus one persistent message per assistant round. */
export class TelegramResponseStream {
  readonly events: AgentEventSink
  private readonly drafts = new Map<string, DraftState>()
  /** toolCallId -> the persistent "🔧 …" message we edit when the result lands */
  private readonly toolProgress = new Map<string, ToolProgressState>()
  private delivery = Promise.resolve()
  private nextDraftId = Math.max(1, Date.now() % 2_000_000_000)
  private firstMessage = true
  private readonly client: TelegramHttpClient
  private readonly source: TelegramMessage
  private readonly signal?: AbortSignal

  constructor(
    client: TelegramHttpClient,
    source: TelegramMessage,
    signal?: AbortSignal
  ) {
    this.client = client
    this.source = source
    this.signal = signal
    this.events = {
      token: (_sessionId, messageId, token) => this.onToken(messageId, token),
      reasoning: (_sessionId, messageId, token) => this.onReasoning(messageId, token),
      toolCall: (_sessionId, _messageId, toolCall) => this.onToolCall(toolCall),
      toolResult: (_message, toolCallId, _toolName, _result, isError, durationMs) =>
        this.onToolResult(toolCallId, isError, durationMs),
      assistantEnd: (_sessionId, messageId, content) => this.onAssistantEnd(messageId, content)
    }
  }

  async flush(): Promise<void> {
    for (const draft of this.drafts.values()) {
      if (draft.timer) clearTimeout(draft.timer)
    }
    await this.delivery
  }

  private onToken(messageId: string, token: string): void {
    if (this.source.chat.type !== 'private' || !messageId) return
    const draft = this.ensureDraft(messageId)
    draft.text += token
    this.scheduleDraftFlush(messageId)
  }

  /**
   * Reasoning shows live in the same draft (ephemeral preview) so the user
   * sees the model is working before any answer token or tool call lands.
   */
  private onReasoning(messageId: string, token: string): void {
    if (this.source.chat.type !== 'private' || !messageId) return
    const draft = this.ensureDraft(messageId)
    draft.text = draft.text.startsWith(REASONING_PREFIX)
      ? draft.text + token
      : REASONING_PREFIX + draft.text + token
    this.scheduleDraftFlush(messageId)
  }

  /**
   * A tool call gets one persistent status message (visible in groups too,
   * where drafts are unavailable). We edit it to ✅/❌ when the result arrives.
   */
  private onToolCall(toolCall: ToolCall): void {
    if (!toolCall?.id) return
    const label = formatBotToolCall(toolCall)
    this.enqueue(async () => {
      try {
        const sent = await this.client.sendSingle(
          this.source.chat.id,
          `🔧 ${label}`,
          { messageThreadId: this.source.message_thread_id },
          this.signal
        )
        this.toolProgress.set(toolCall.id, { messageId: sent.message_id, label })
      } catch (error) {
        log('warn', `Telegram tool progress send failed: ${safeError(error)}`)
      }
    })
  }

  private onToolResult(toolCallId: string, isError: boolean, durationMs: number): void {
    const progress = this.toolProgress.get(toolCallId)
    if (!progress) return
    this.toolProgress.delete(toolCallId)
    const status = isError ? `❌ 失败 · ${formatDuration(durationMs)}` : `✅ ${formatDuration(durationMs)}`
    this.enqueue(async () => {
      try {
        await this.client.editMessageText(
          this.source.chat.id,
          progress.messageId,
          `🔧 ${progress.label}\n${status}`,
          this.signal
        )
      } catch (error) {
        // "message is not modified" and transient failures are non-fatal noise
        log('warn', `Telegram tool progress edit failed: ${safeError(error)}`)
      }
    })
  }

  private onAssistantEnd(messageId: string, content: string): void {
    const draft = this.drafts.get(messageId)
    if (draft?.timer) clearTimeout(draft.timer)
    this.drafts.delete(messageId)
    if (!content.trim()) return

    const replyToMessageId = this.firstMessage ? this.source.message_id : undefined
    this.firstMessage = false
    this.enqueue(() => this.client.sendText(this.source.chat.id, content, {
      messageThreadId: this.source.message_thread_id,
      replyToMessageId
    }, this.signal))
  }

  private ensureDraft(messageId: string): DraftState {
    let draft = this.drafts.get(messageId)
    if (!draft) {
      draft = { draftId: this.allocateDraftId(), text: '', timer: null }
      this.drafts.set(messageId, draft)
    }
    return draft
  }

  private scheduleDraftFlush(messageId: string): void {
    const draft = this.drafts.get(messageId)
    if (!draft || draft.timer) return
    draft.timer = setTimeout(() => {
      draft.timer = null
      const text = lastCharacters(draft.text, DRAFT_TEXT_LIMIT)
      this.enqueue(() => this.client.sendDraft(
        this.source.chat.id,
        draft.draftId,
        text,
        this.source.message_thread_id,
        this.signal
      ))
    }, DRAFT_INTERVAL_MS)
  }

  private enqueue(task: () => Promise<unknown>): void {
    this.delivery = this.delivery.then(task).then(() => undefined).catch(error => {
      log('warn', `Telegram response delivery failed: ${safeError(error)}`)
    })
  }

  private allocateDraftId(): number {
    const id = this.nextDraftId
    this.nextDraftId = this.nextDraftId >= 2_000_000_000 ? 1 : this.nextDraftId + 1
    return id
  }
}

const REASONING_PREFIX = '💭 '

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function lastCharacters(text: string, limit: number): string {
  const characters = Array.from(text)
  return characters.length <= limit ? text : characters.slice(-limit).join('')
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}
