import {
  QQBot,
  contentSanitizer,
  messageFilter,
  type Logger,
  type QQBotInboundMessage,
  type ReplyTarget
} from '@tencent-connect/qqbot-nodejs'
import { log } from '../llm/logger.ts'

export type QQMessage = QQBotInboundMessage
export type QQMessageTarget = ReplyTarget

export interface QQTextStream {
  update(fullText: string): Promise<void>
  complete(): Promise<unknown>
  cancel(): void
}

export interface QQClient {
  readonly appId: string
  onReady(handler: () => void): void
  onError(handler: (error: Error) => void): void
  onMessage(handler: (message: QQMessage) => void | Promise<void>): void
  verifyCredentials(): Promise<void>
  start(signal: AbortSignal): Promise<void>
  stop(): void
  sendText(target: QQMessageTarget, text: string): Promise<void>
  openStream(target: QQMessageTarget): QQTextStream
}

export type QQClientFactory = (config: { appId: string; appSecret: string }) => QQClient

const QQ_TEXT_LIMIT = 1500

export function splitQQText(text: string, limit = QQ_TEXT_LIMIT): string[] {
  const characters = Array.from(text)
  if (characters.length === 0) return []
  const chunks: string[] = []
  for (let offset = 0; offset < characters.length; offset += limit) {
    chunks.push(characters.slice(offset, offset + limit).join(''))
  }
  return chunks
}

/** Thin boundary around Tencent's SDK; the rest of the app depends on QQClient only. */
export class TencentQQClient implements QQClient {
  private readonly bot: QQBot

  constructor(config: { appId: string; appSecret: string }) {
    this.bot = new QQBot({
      appId: config.appId,
      appSecret: config.appSecret,
      markdownSupport: false,
      logger: qqLogger
    })
    this.bot.use(messageFilter(), contentSanitizer())
  }

  get appId(): string {
    return this.bot.appId
  }

  onReady(handler: () => void): void {
    this.bot.on('ready', handler)
  }

  onError(handler: (error: Error) => void): void {
    this.bot.on('error', handler)
  }

  onMessage(handler: (message: QQMessage) => void | Promise<void>): void {
    this.bot.on('message', (_context, message) => handler(message))
  }

  async verifyCredentials(): Promise<void> {
    await this.bot.api.getToken()
  }

  start(signal: AbortSignal): Promise<void> {
    return this.bot.start(signal)
  }

  stop(): void {
    this.bot.stop()
  }

  async sendText(target: QQMessageTarget, text: string): Promise<void> {
    for (const chunk of splitQQText(text)) await this.bot.sendText(target, chunk)
  }

  openStream(target: QQMessageTarget): QQTextStream {
    return this.bot.openStream({ target, throttleMs: 500 })
  }
}

export const createQQClient: QQClientFactory = config => new TencentQQClient(config)

const qqLogger: Logger = {
  info: message => log('info', message),
  warn: message => log('warn', message),
  error: message => log('error', message)
}
