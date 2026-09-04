import type { TelegramBotConfig } from '../../shared/types'
import { AgentAbortedError } from '../../shared/types'
import { normalizeTelegramBotConfig } from '../../shared/telegram'
import type { PermissionBroker } from '../agent/permissionBroker'
import { combineAgentEventSinks, type AgentEventSink } from '../agent/persistedCallbacks'
import type { BotActivity, BotPlatformService } from '../bot/contracts'
import type { BotAgentBridge } from '../bot/agentBridge'
import { log } from '../llm/logger'
import { getFetch } from '../net/fetch'
import {
  isValidTelegramBotToken,
  TelegramApiError,
  TelegramHttpClient,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramPhotoSize,
  type TelegramUser
} from './client'
import {
  TelegramPermissionPresenter,
  isPermissionCallbackAuthorized,
  parsePermissionCallback,
  type TelegramPermissionRoute
} from './permissionPresenter'
import { TelegramResponseStream } from './responseStream'

export class TelegramBotService implements BotPlatformService<TelegramBotConfig> {
  readonly channel = 'telegram'
  private controller: AbortController | null = null
  private polling: Promise<void> | null = null
  private client: TelegramHttpClient | null = null
  private bot: TelegramUser | null = null
  private config = normalizeTelegramBotConfig(undefined)
  private readonly queues = new Map<string, Promise<void>>()
  private readonly activeRuns = new Map<string, AbortController>()
  private readonly activeSessionRuns = new Map<string, AbortController>()
  private generation = 0
  private onActivity?: (activity: BotActivity) => boolean | void
  private agentEvents: AgentEventSink = {}
  private readonly permissionRoutes = new Map<string, TelegramPermissionRoute>()
  private readonly agent: BotAgentBridge
  private readonly permissions: PermissionBroker

  constructor(agent: BotAgentBridge, permissions: PermissionBroker) {
    this.agent = agent
    this.permissions = permissions
  }

  setActivityListener(listener: (activity: BotActivity) => boolean | void): void {
    this.onActivity = listener
  }

  setAgentEventSink(sink: AgentEventSink): void {
    this.agentEvents = sink
  }

  abortSession(sessionId: string): boolean {
    const run = this.activeSessionRuns.get(sessionId)
    run?.abort()
    if (run) this.permissions.cancelSession(sessionId)
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
    for (const sessionId of this.activeSessionRuns.keys()) this.permissions.cancelSession(sessionId)
    for (const run of this.activeRuns.values()) run.abort()
    this.activeRuns.clear()
    this.activeSessionRuns.clear()
    this.permissionRoutes.clear()
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
          if (update.callback_query) this.dispatchCallback(update.callback_query)
          if (update.message) this.dispatchMessage(update.message)
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

  private dispatchMessage(message: TelegramMessage): void {
    const sender = message.from
    const text = (message.text || message.caption || '').trim()
    const photos = message.photo || []
    if (!text && photos.length === 0) return
    if (!sender || sender.is_bot || !this.client || !this.bot) return

    if (/^\/id(?:@\w+)?(?:\s|$)/i.test(commandText(message))) {
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

    // 会话按发送者隔离：群聊里不同用户不共享上下文；私聊 sender 与 chat 一致，行为不变
    const conversationId = `${message.chat.id}:${message.message_thread_id || 0}:${sender.id}`
    if (/^\/stop(?:@\w+)?(?:\s|$)/i.test(commandText(message))) {
      const run = this.activeRuns.get(conversationId)
      run?.abort()
      if (run) {
        for (const [sessionId, controller] of this.activeSessionRuns) {
          if (controller === run) this.permissions.cancelSession(sessionId)
        }
      }
      void this.client.sendText(message.chat.id, run ? 'Stopped.' : 'Nothing is running.', replyOptions(message), this.controller?.signal)
        .catch(error => log('warn', `Telegram /stop reply failed: ${safeError(error)}`))
      return
    }

    const previous = this.queues.get(conversationId) || Promise.resolve()
    const generation = this.generation
    const queued = previous.catch(() => {}).then(() => this.processMessage(conversationId, message, text, photos, generation))
    this.queues.set(conversationId, queued)
    void queued.finally(() => {
      if (this.queues.get(conversationId) === queued) this.queues.delete(conversationId)
    })
  }

  private dispatchCallback(query: TelegramCallbackQuery): void {
    if (!this.client) return
    const parsed = parsePermissionCallback(query.data)
    if (!parsed) return
    const route = this.permissionRoutes.get(parsed.permissionId)
    const authorized = isPermissionCallbackAuthorized(route, query, this.config.allowedUserIds)

    if (!authorized) {
      void this.client.answerCallbackQuery(query.id, 'This permission request is invalid or expired.', true, this.controller?.signal)
        .catch(error => log('warn', `Telegram callback reply failed: ${safeError(error)}`))
      return
    }

    const accepted = this.permissions.respond(parsed.permissionId, parsed.allowed)
    void this.client.answerCallbackQuery(
      query.id,
      accepted ? (parsed.allowed ? 'Approved.' : 'Denied.') : 'This permission request has expired.',
      !accepted,
      this.controller?.signal
    ).catch(error => log('warn', `Telegram callback reply failed: ${safeError(error)}`))
  }

  private async processMessage(
    conversationId: string,
    message: TelegramMessage,
    text: string,
    photos: TelegramPhotoSize[],
    generation: number
  ): Promise<void> {
    if (generation !== this.generation || !this.client || !this.bot || this.controller?.signal.aborted) return
    const runController = new AbortController()
    const response = new TelegramResponseStream(this.client, message, this.controller?.signal)
    const permissionPresenter = new TelegramPermissionPresenter(
      this.client,
      message,
      message.from!.id,
      route => this.permissionRoutes.set(route.permissionId, route),
      permissionId => this.permissionRoutes.delete(permissionId),
      this.controller?.signal
    )
    this.activeRuns.set(conversationId, runController)
    let sessionId: string | undefined
    try {
      // 会话按发送者隔离，群聊历史里用名字标注发言人，模型才能区分是谁说的
      const senderName = displayName(message.from!)
      const conversationLabel = message.chat.type === 'private' ? undefined : `${senderName}:`
      const images = await this.downloadPhotos(photos, runController.signal)
      const result = await this.agent.handle({
        channel: this.channel,
        accountId: String(this.bot.id),
        conversationId,
        conversationTitle: telegramConversationTitle(message),
        senderId: String(message.from!.id),
        senderName,
        text: conversationLabel ? `${conversationLabel} ${text}`.trim() : text,
        images: images.length > 0 ? images : undefined,
        approveMode: this.config.approveMode,
        signal: runController.signal,
        events: combineAgentEventSinks(this.agentEvents, response.events),
        permissionPresenters: [permissionPresenter],
        permissionTimeoutMs: 10 * 60 * 1000,
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
      await response.flush()
      this.onActivity?.({ sessionId, state: 'complete' })
    } catch (error) {
      await response.flush()
      if (error instanceof AgentAbortedError) {
        if (sessionId) this.onActivity?.({ sessionId, state: 'aborted' })
        return
      }
      log('error', `Telegram message failed: ${safeError(error)}`)
      await this.client.sendText(message.chat.id, `Error: ${safeError(error)}`, replyOptions(message), this.controller?.signal)
        .catch(sendError => log('warn', `Telegram error reply failed: ${safeError(sendError)}`))
      if (sessionId) this.onActivity?.({ sessionId, state: 'error' })
    } finally {
      if (sessionId) this.permissions.cancelSession(sessionId)
      if (this.activeRuns.get(conversationId) === runController) this.activeRuns.delete(conversationId)
      if (sessionId && this.activeSessionRuns.get(sessionId) === runController) this.activeSessionRuns.delete(sessionId)
    }
  }

  /**
   * 下载消息里的图片并转成 base64 data URL（对接 UIMessage.images 多模态管线）。
   * 单条消息最多取前 MAX_PHOTOS 张；任一张失败只记日志，不影响其余图片和文本。
   */
  private async downloadPhotos(photos: TelegramPhotoSize[], signal: AbortSignal): Promise<string[]> {
    if (!this.client || photos.length === 0) return []
    const images: string[] = []
    for (const photo of photos.slice(0, MAX_PHOTOS)) {
      try {
        const file = await this.client.getFile(photo.file_id, signal)
        if (!file.file_path) continue
        const base64 = await this.client.downloadFileAsBase64(file.file_path, MAX_PHOTO_BYTES, signal)
        images.push(`data:image/${inferPhotoMime(file.file_path)};base64,${base64}`)
      } catch (error) {
        if (isAbort(error)) break
        log('warn', `Telegram photo download failed: ${safeError(error)}`)
      }
    }
    return images
  }
}

const MAX_PHOTOS = 4
const MAX_PHOTO_BYTES = 20 * 1024 * 1024

/** 纯文本命令检测：图片配文（caption）不参与 /id /stop 匹配 */
function commandText(message: TelegramMessage): string {
  return message.text?.trim() || ''
}

/** Telegram 图片下载后统一按 JPEG 处理（Bot API 的 photo 均为 JPEG）；有扩展名时尽量尊重 */
function inferPhotoMime(filePath: string): string {
  const ext = /\.(\w+)$/.exec(filePath)?.[1]?.toLowerCase()
  if (ext === 'png' || ext === 'webp' || ext === 'gif') return ext
  return 'jpeg'
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
