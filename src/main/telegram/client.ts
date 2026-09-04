export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TelegramDocument {
  file_id: string
  file_unique_id: string
  mime_type?: string
  file_name?: string
  file_size?: number
}

export interface TelegramMessage {
  message_id: number
  message_thread_id?: number
  from?: TelegramUser
  chat: TelegramChat
  text?: string
  /** 图片/文档的说明文字。用户发带图消息时，配文在这里而不是 text 字段 */
  caption?: string
  /** 图片消息：同一张图的多个尺寸，最后一张分辨率最高 */
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

export interface TelegramInlineKeyboardButton {
  text: string
  callback_data: string
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][]
}

export interface TelegramFile {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string
}

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

export class TelegramApiError extends Error {
  readonly errorCode?: number
  readonly retryAfterSeconds?: number

  constructor(
    message: string,
    errorCode?: number,
    retryAfterSeconds?: number
  ) {
    super(message)
    this.name = 'TelegramApiError'
    this.errorCode = errorCode
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function isValidTelegramBotToken(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token)
}

export function splitTelegramText(text: string, limit = 4000): string[] {
  const characters = Array.from(text)
  if (characters.length === 0) return []
  const chunks: string[] = []
  for (let offset = 0; offset < characters.length; offset += limit) {
    chunks.push(characters.slice(offset, offset + limit).join(''))
  }
  return chunks
}

export class TelegramHttpClient {
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly apiBase: string

  constructor(
    token: string,
    fetchImpl: typeof fetch,
    apiBase = 'https://api.telegram.org'
  ) {
    this.token = token
    this.fetchImpl = fetchImpl
    this.apiBase = apiBase
  }

  getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {}, signal)
  }

  getUpdates(offset: number | undefined, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', {
      offset,
      timeout: 25,
      allowed_updates: ['message', 'callback_query']
    }, signal)
  }

  async sendText(
    chatId: number,
    text: string,
    options: { messageThreadId?: number; replyToMessageId?: number } = {},
    signal?: AbortSignal
  ): Promise<void> {
    const chunks = splitTelegramText(text)
    for (let index = 0; index < chunks.length; index++) {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: chunks[index],
        message_thread_id: options.messageThreadId,
        reply_parameters: index === 0 && options.replyToMessageId
          ? { message_id: options.replyToMessageId }
          : undefined
      }, signal)
    }
  }

  /** 发送单条消息并返回它（进度消息需要记住 message_id 以便编辑）。超长文本截断而不是分条 */
  sendSingle(
    chatId: number,
    text: string,
    options: { messageThreadId?: number; replyToMessageId?: number } = {},
    signal?: AbortSignal
  ): Promise<TelegramMessage> {
    const characters = Array.from(text)
    const body = characters.length <= 4000 ? text : characters.slice(characters.length - 4000).join('')
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text: body,
      message_thread_id: options.messageThreadId,
      reply_parameters: options.replyToMessageId
        ? { message_id: options.replyToMessageId }
        : undefined
    }, signal)
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    signal?: AbortSignal
  ): Promise<TelegramMessage | boolean> {
    const characters = Array.from(text)
    const body = characters.length <= 4000 ? text : characters.slice(characters.length - 4000).join('')
    return this.call<TelegramMessage | boolean>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: body
    }, signal)
  }

  sendDraft(
    chatId: number,
    draftId: number,
    text: string,
    messageThreadId?: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    return this.call<boolean>('sendMessageDraft', {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      draft_id: draftId,
      text
    }, signal)
  }

  sendPermissionPrompt(
    chatId: number,
    text: string,
    keyboard: TelegramInlineKeyboardMarkup,
    messageThreadId?: number,
    signal?: AbortSignal
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text,
      message_thread_id: messageThreadId,
      reply_markup: keyboard
    }, signal)
  }

  answerCallbackQuery(
    callbackQueryId: string,
    text: string,
    showAlert = false,
    signal?: AbortSignal
  ): Promise<boolean> {
    return this.call<boolean>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert
    }, signal)
  }

  editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    keyboard: TelegramInlineKeyboardMarkup,
    signal?: AbortSignal
  ): Promise<TelegramMessage | boolean> {
    return this.call<TelegramMessage | boolean>('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: keyboard
    }, signal)
  }

  /** 获取文件元信息（含可用于下载的 file_path）。file_path 有效期约 1 小时 */
  getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile> {
    return this.call<TelegramFile>('getFile', { file_id: fileId }, signal)
  }

  /**
   * 下载 Bot API 文件，返回 base64（不含 data: 前缀）。
   * Telegram 官方下载上限 20MB，超过直接抛错避免拉爆内存。
   */
  async downloadFileAsBase64(filePath: string, maxBytes = 20 * 1024 * 1024, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchImpl(`${this.apiBase}/file/bot${this.token}/${encodeURI(filePath)}`, { signal })
    if (!response.ok) {
      throw new TelegramApiError(`Telegram file download failed with HTTP ${response.status}`, response.status)
    }
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > maxBytes) throw new Error(`Telegram file is too large (${declared} bytes).`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error(`Telegram file is too large (${bytes.byteLength} bytes).`)
    return Buffer.from(bytes).toString('base64')
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })

    let payload: TelegramApiResponse<T>
    try {
      payload = await response.json() as TelegramApiResponse<T>
    } catch {
      throw new TelegramApiError(`Telegram ${method} returned invalid JSON`, response.status)
    }
    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new TelegramApiError(
        payload.description || `Telegram ${method} failed with HTTP ${response.status}`,
        payload.error_code || response.status,
        payload.parameters?.retry_after
      )
    }
    return payload.result
  }
}
