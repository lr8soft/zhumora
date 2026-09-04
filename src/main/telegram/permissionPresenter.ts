import type {
  PermissionPresenter,
  PermissionRequest,
  PermissionResolution
} from '../agent/permissionBroker'
import { log } from '../llm/logger.ts'
import { formatBotPermissionPrompt } from '../bot/permissionPrompt.ts'
import type { TelegramCallbackQuery, TelegramHttpClient, TelegramMessage } from './client'

const CALLBACK_PREFIX = 'zhp'

export interface TelegramPermissionRoute {
  permissionId: string
  senderId: number
  chatId: number
}

interface PromptState {
  resolved: boolean
  messageId?: number
}

export class TelegramPermissionPresenter implements PermissionPresenter {
  private readonly prompts = new Map<string, PromptState>()
  private readonly client: TelegramHttpClient
  private readonly source: TelegramMessage
  private readonly senderId: number
  private readonly register: (route: TelegramPermissionRoute) => void
  private readonly unregister: (permissionId: string) => void
  private readonly signal?: AbortSignal

  constructor(
    client: TelegramHttpClient,
    source: TelegramMessage,
    senderId: number,
    register: (route: TelegramPermissionRoute) => void,
    unregister: (permissionId: string) => void,
    signal?: AbortSignal
  ) {
    this.client = client
    this.source = source
    this.senderId = senderId
    this.register = register
    this.unregister = unregister
    this.signal = signal
  }

  async present(request: PermissionRequest): Promise<void> {
    const state: PromptState = { resolved: false }
    this.prompts.set(request.id, state)
    const sent = await this.client.sendPermissionPrompt(
      this.source.chat.id,
      formatPermissionPrompt(request),
      {
        inline_keyboard: [[
          { text: '✅ Allow', callback_data: permissionCallbackData(request.id, true) },
          { text: '❌ Deny', callback_data: permissionCallbackData(request.id, false) }
        ]]
      },
      this.source.message_thread_id,
      this.signal
    )
    state.messageId = sent.message_id
    if (state.resolved) {
      await this.removeButtons(state.messageId)
      return
    }
    this.register({ permissionId: request.id, senderId: this.senderId, chatId: this.source.chat.id })
  }

  async resolve(request: PermissionRequest, _resolution: PermissionResolution): Promise<void> {
    const state = this.prompts.get(request.id)
    if (!state) return
    state.resolved = true
    this.unregister(request.id)
    if (state.messageId) await this.removeButtons(state.messageId)
    this.prompts.delete(request.id)
  }

  private async removeButtons(messageId: number): Promise<void> {
    try {
      await this.client.editMessageReplyMarkup(
        this.source.chat.id,
        messageId,
        { inline_keyboard: [] },
        this.signal
      )
    } catch (error) {
      log('warn', `Failed to clear Telegram permission buttons: ${safeError(error)}`)
    }
  }
}

export function permissionCallbackData(permissionId: string, allowed: boolean): string {
  return `${CALLBACK_PREFIX}:${permissionId}:${allowed ? '1' : '0'}`
}

export function parsePermissionCallback(data: string | undefined): { permissionId: string; allowed: boolean } | null {
  if (!data) return null
  const match = /^zhp:([A-Za-z0-9_-]+):([01])$/.exec(data)
  return match ? { permissionId: match[1], allowed: match[2] === '1' } : null
}

export function isPermissionCallbackAuthorized(
  route: TelegramPermissionRoute | undefined,
  query: TelegramCallbackQuery,
  allowedUserIds: string[]
): boolean {
  return !!route
    && route.senderId === query.from.id
    && route.chatId === query.message?.chat.id
    && allowedUserIds.includes(String(query.from.id))
}

export function formatPermissionPrompt(request: PermissionRequest): string {
  return formatBotPermissionPrompt(request)
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}
