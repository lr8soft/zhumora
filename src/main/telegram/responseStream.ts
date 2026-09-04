import type { AgentEventSink } from '../agent/persistedCallbacks'
import { log } from '../llm/logger.ts'
import type { TelegramHttpClient, TelegramMessage } from './client'

const DRAFT_INTERVAL_MS = 700
const DRAFT_TEXT_LIMIT = 4000

interface DraftState {
  draftId: number
  text: string
  timer: ReturnType<typeof setTimeout> | null
}

/** Telegram delivery adapter: throttled drafts plus one persistent message per assistant round. */
export class TelegramResponseStream {
  readonly events: AgentEventSink
  private readonly drafts = new Map<string, DraftState>()
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
    let draft = this.drafts.get(messageId)
    if (!draft) {
      draft = { draftId: this.allocateDraftId(), text: '', timer: null }
      this.drafts.set(messageId, draft)
    }
    draft.text += token
    if (draft.timer) return
    draft.timer = setTimeout(() => {
      draft!.timer = null
      const text = lastCharacters(draft!.text, DRAFT_TEXT_LIMIT)
      this.enqueue(() => this.client.sendDraft(
        this.source.chat.id,
        draft!.draftId,
        text,
        this.source.message_thread_id,
        this.signal
      ))
    }, DRAFT_INTERVAL_MS)
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

function lastCharacters(text: string, limit: number): string {
  const characters = Array.from(text)
  return characters.length <= limit ? text : characters.slice(-limit).join('')
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}
