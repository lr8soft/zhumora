import type { TelegramBotConfig } from '../../shared/types'
import { normalizeTelegramBotConfig } from '../../shared/telegram'
import { log } from '../llm/logger'
import { getFetch } from '../net/fetch'
import {
  isValidTelegramBotToken,
  TelegramApiError,
  TelegramHttpClient,
  type TelegramMessage,
  type TelegramUser
} from './client'
import { isTelegramAgentAbort, TelegramAgentBridge } from './agentBridge'

export interface TelegramActivity {
  sessionId: string
  state: 'running' | 'complete' | 'error' | 'aborted'
}

export class TelegramBotService {
  private controller: AbortController | null = null
  private polling: Promise<void> | null = null
  private client: TelegramHttpClient | null = null
  private bot: TelegramUser | null = null
  private config = normalizeTelegramBotConfig(undefined)
  private readonly queues = new Map<string, Promise<void>>()
  private readonly activeRuns = new Map<string, AbortController>()
  private readonly activeSessionRuns = new Map<string, AbortController>()
  private generation = 0
  private onActivity?: (activity: TelegramActivity) => boolean | void
  private readonly agent: TelegramAgentBridge

  constructor(agent: TelegramAgentBridge) {
    this.agent = agent
  }

  setActivityListener(listener: (activity: TelegramActivity) => boolean | void): void {
    this.onActivity = listener
  }

  abortSession(sessionId: string): boolean {
    const run = this.activeSessionRuns.get(sessionId)
    run?.abort()
    return !!run
  }

  async test(input: TelegramBotConfig): Promise<{ name: string; username?: string }> {
    const config = normalizeTelegramBotConfig(input)
    if (!isValidTelegramBotToken(config.token)) throw new Error('Telegram Bot token format is invalid.')
    const bot = await new TelegramHttpClient(config.token, getFetch()).getMe()
    return { name: bot.first_name, username: bot.username }
  }

  async configure(input: TelegramBotConfig): Promise<void> {
    await this.stop()
    this.config = normalizeTelegramBotConfig(input)
    if (!this.config.enabled) return
    if (!isValidTelegramBotToken(this.config.token)) {
      throw new Error('Telegram Bot token format is invalid.')
    }

    const generation = this.generation
    const controller = new AbortController()
    const client = new TelegramHttpClient(this.config.token, getFetch())
    this.controller = controller
    this.client = client
    let bot: TelegramUser
    try {
      bot = await client.getMe(controller.signal)
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted || isAbort(error)) return
      if (this.controller === controller) {
        this.controller = null
        this.client = null
      }
      throw error
    }
    if (generation !== this.generation || controller.signal.aborted) return
    this.bot = bot
    if (this.config.allowedUserIds.length === 0) {
      log('warn', 'Telegram bot started without allowed users; only /id will be accepted.')
    }
    log('info', `Telegram bot @${bot.username || bot.first_name} connected via HTTPS long polling`)
    this.polling = this.pollLoop(controller.signal).catch(error => {
      if (!controller.signal.aborted) log('error', `Telegram polling stopped: ${safeError(error)}`)
    })
  }

  async stop(): Promise<void> {
    this.generation++
    this.controller?.abort()
    this.controller = null
    for (const run of this.activeRuns.values()) run.abort()
    this.activeRuns.clear()
    this.activeSessionRuns.clear()
    const polling = this.polling
    this.polling = null
    if (polling) await polling.catch(() => {})
    this.client = null
    this.bot = null
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let offset: number | undefined
    let failedAttempts = 0
    while (!signal.aborted && this.client) {
      try {
        const updates = await this.client.getUpdates(offset, signal)
        failedAttempts = 0
        for (const update of updates) {
          offset = Math.max(offset || 0, update.update_id + 1)
          if (update.message) this.dispatch(update.message)
        }
      } catch (error) {
        if (signal.aborted || isAbort(error)) return
        if (error instanceof TelegramApiError && error.errorCode === 409) {
          throw new Error('Telegram getUpdates conflicts with an existing webhook or another polling client.')
        }
        failedAttempts++
        const retryMs = error instanceof TelegramApiError && error.retryAfterSeconds
          ? error.retryAfterSeconds * 1000
          : Math.min(1000 * 2 ** (failedAttempts - 1), 30000)
        log('warn', `Telegram polling failed: ${safeError(error)}; retrying in ${Math.round(retryMs / 1000)}s`)
        await abortableDelay(retryMs, signal)
      }
    }
  }

  private dispatch(message: TelegramMessage): void {
    const text = message.text?.trim()
    const sender = message.from
    if (!text || !sender || sender.is_bot || !this.client || !this.bot) return

    if (/^\/id(?:@\w+)?(?:\s|$)/i.test(text)) {
      void this.client.sendText(
        message.chat.id,
        `Your Telegram User ID: ${sender.id}\nChat ID: ${message.chat.id}`,
        replyOptions(message),
        this.controller?.signal
      ).catch(error => log('warn', `Telegram /id reply failed: ${safeError(error)}`))
      return
    }

    if (!this.config.allowedUserIds.includes(String(sender.id))) {
      log('warn', `Ignored Telegram message from unauthorized user ${sender.id}`)
      return
    }

    const conversationId = `${message.chat.id}:${message.message_thread_id || 0}`
    if (/^\/stop(?:@\w+)?(?:\s|$)/i.test(text)) {
      const run = this.activeRuns.get(conversationId)
      run?.abort()
      void this.client.sendText(message.chat.id, run ? 'Stopped.' : 'Nothing is running.', replyOptions(message), this.controller?.signal)
        .catch(error => log('warn', `Telegram /stop reply failed: ${safeError(error)}`))
      return
    }

    const previous = this.queues.get(conversationId) || Promise.resolve()
    const generation = this.generation
    const queued = previous.catch(() => {}).then(() => this.processMessage(conversationId, message, text, generation))
    this.queues.set(conversationId, queued)
    void queued.finally(() => {
      if (this.queues.get(conversationId) === queued) this.queues.delete(conversationId)
    })
  }

  private async processMessage(conversationId: string, message: TelegramMessage, text: string, generation: number): Promise<void> {
    if (generation !== this.generation || !this.client || !this.bot || this.controller?.signal.aborted) return
    const runController = new AbortController()
    this.activeRuns.set(conversationId, runController)
    let sessionId: string | undefined
    try {
      const result = await this.agent.handle({
        accountId: String(this.bot.id),
        conversationId,
        conversationTitle: telegramConversationTitle(message),
        senderName: displayName(message.from!),
        text,
        signal: runController.signal,
        onSessionReady: id => {
          const accepted = this.onActivity?.({ sessionId: id, state: 'running' }) !== false
          if (accepted) {
            sessionId = id
            this.activeSessionRuns.set(id, runController)
          }
          return accepted
        }
      })
      sessionId = result.sessionId
      await this.client.sendText(message.chat.id, result.text, replyOptions(message), this.controller?.signal)
      this.onActivity?.({ sessionId, state: 'complete' })
    } catch (error) {
      if (isTelegramAgentAbort(error)) {
        if (sessionId) this.onActivity?.({ sessionId, state: 'aborted' })
        return
      }
      log('error', `Telegram message failed: ${safeError(error)}`)
      await this.client.sendText(message.chat.id, `Error: ${safeError(error)}`, replyOptions(message), this.controller?.signal)
        .catch(sendError => log('warn', `Telegram error reply failed: ${safeError(sendError)}`))
      if (sessionId) this.onActivity?.({ sessionId, state: 'error' })
    } finally {
      if (this.activeRuns.get(conversationId) === runController) this.activeRuns.delete(conversationId)
      if (sessionId && this.activeSessionRuns.get(sessionId) === runController) this.activeSessionRuns.delete(sessionId)
    }
  }
}

function replyOptions(message: TelegramMessage): { messageThreadId?: number; replyToMessageId?: number } {
  return { messageThreadId: message.message_thread_id, replyToMessageId: message.message_id }
}

function telegramConversationTitle(message: TelegramMessage): string {
  const name = message.chat.title || [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ')
    || message.chat.username || String(message.chat.id)
  return `Telegram · ${name}`
}

function displayName(user: TelegramUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id)
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}
