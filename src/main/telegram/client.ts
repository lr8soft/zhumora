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

export interface TelegramMessage {
  message_id: number
  message_thread_id?: number
  from?: TelegramUser
  chat: TelegramChat
  text?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
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
      allowed_updates: ['message']
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
