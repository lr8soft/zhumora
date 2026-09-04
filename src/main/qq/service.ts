import type { QQBotConfig } from '../../shared/types'
import { AgentAbortedError } from '../../shared/types.ts'
import { normalizeQQBotConfig } from '../../shared/qq.ts'
import type { PermissionBroker } from '../agent/permissionBroker'
import { combineAgentEventSinks, type AgentEventSink } from '../agent/persistedCallbacks.ts'
import type { BotAgentBridge } from '../bot/agentBridge'
import type { BotActivity, BotPlatformService } from '../bot/contracts'
import { BotRunCoordinator, type BotRunContext } from '../bot/runCoordinator.ts'
import { log } from '../llm/logger.ts'
import {
  createQQClient,
  type QQButtonEvent,
  type QQClient,
  type QQClientFactory,
  type QQMessage
} from './client.ts'
import {
  isQQPermissionCallbackAuthorized,
  parseQQPermissionCallback,
  QQPermissionPresenter,
  type QQPermissionRoute
} from './permissionPresenter.ts'
import { QQResponseStream } from './responseStream.ts'

const STARTUP_TIMEOUT_MS = 30_000
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

interface QQBotServiceOptions {
  clientFactory?: QQClientFactory
  getFetch?: () => typeof fetch
}

export class QQBotService implements BotPlatformService<QQBotConfig> {
  readonly channel = 'qq'
  private controller: AbortController | null = null
  private running: Promise<void> | null = null
  private client: QQClient | null = null
  private config = normalizeQQBotConfig(undefined)
  private generation = 0
  private agentEvents: AgentEventSink = {}
  private readonly permissionRoutes = new Map<string, QQPermissionRoute>()
  private readonly runs: BotRunCoordinator
  private readonly agent: BotAgentBridge
  private readonly permissions: PermissionBroker
  private readonly clientFactory: QQClientFactory
  private readonly getFetch: () => typeof fetch

  constructor(
    agent: BotAgentBridge,
    permissions: PermissionBroker,
    options: QQBotServiceOptions = {}
  ) {
    this.agent = agent
    this.permissions = permissions
    this.clientFactory = options.clientFactory || createQQClient
    this.getFetch = options.getFetch || (() => fetch)
    this.runs = new BotRunCoordinator(permissions)
  }

  setActivityListener(listener: (activity: BotActivity) => boolean | void): void {
    this.runs.setActivityListener(listener)
  }

  setAgentEventSink(sink: AgentEventSink): void {
    this.agentEvents = sink
  }

  abortSession(sessionId: string): boolean {
    return this.runs.abortSession(sessionId)
  }

  async test(input: QQBotConfig): Promise<{ name: string; username?: string }> {
    const config = normalizeQQBotConfig(input)
    validateQQConfig(config)
    const client = this.clientFactory(config)
    try {
      await client.verifyCredentials()
      return { name: `QQ Bot ${config.appId}` }
    } finally {
      client.stop()
    }
  }

  async configure(input: QQBotConfig): Promise<void> {
    await this.stop()
    this.config = normalizeQQBotConfig(input)
    if (!this.config.enabled) return
    validateQQConfig(this.config)

    const generation = this.generation
    const controller = new AbortController()
    const client = this.clientFactory(this.config)
    this.controller = controller
    this.client = client

    const ready = createReadySignal(client)
    client.onMessage(message => this.dispatchMessage(message))
    client.onInteraction(event => this.dispatchInteraction(event))
    client.onError(error => log('warn', `QQ Bot gateway error: ${safeError(error)}`))

    const running = client.start(controller.signal)
    this.running = running
    void running.catch(error => {
      if (!controller.signal.aborted && generation === this.generation) {
        log('error', `QQ Bot gateway stopped: ${safeError(error)}`)
      }
    })

    try {
      await waitUntilReady(ready, running, STARTUP_TIMEOUT_MS)
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted || isAbort(error)) return
      client.stop()
      controller.abort()
      if (this.client === client) this.client = null
      if (this.controller === controller) this.controller = null
      if (this.running === running) this.running = null
      await running.catch(() => {})
      throw error
    }
    if (generation !== this.generation || controller.signal.aborted) return
    if (this.config.allowedUserIds.length === 0) {
      log('warn', 'QQ Bot started without allowed users; only /id will be accepted.')
    }
    log('info', `QQ Bot ${client.appId} connected via WebSocket Gateway`)
  }

  async stop(): Promise<void> {
    this.generation++
    const controller = this.controller
    const client = this.client
    const running = this.running
    this.controller = null
    this.client = null
    this.running = null
    controller?.abort()
    client?.stop()
    await this.runs.stop()
    this.permissionRoutes.clear()
    if (running) await running.catch(() => {})
  }

  private dispatchMessage(message: QQMessage): void {
    const client = this.client
    if (!client || message.senderIsBot) return
    const text = message.content.trim()
    const imageAttachments = collectImageAttachments(message)
    if (!text && imageAttachments.length === 0) return

    if (/^\/id(?:\s|$)/i.test(text)) {
      const group = message.replyTarget.scope === 'group'
        ? `\nGroup OpenID: ${message.replyTarget.targetId}`
        : ''
      void client.sendText(message.replyTarget, `Your QQ User OpenID: ${message.senderId}${group}`)
        .catch(error => log('warn', `QQ /id reply failed: ${safeError(error)}`))
      return
    }

    if (!this.config.allowedUserIds.includes(message.senderId)) {
      log('warn', `Ignored QQ message from unauthorized user ${message.senderId}`)
      return
    }

    const conversationId = qqConversationId(message)
    if (/^\/stop(?:\s|$)/i.test(text)) {
      const stopped = this.runs.abortConversation(conversationId)
      void client.sendText(message.replyTarget, stopped ? 'Stopped.' : 'Nothing is running.')
        .catch(error => log('warn', `QQ /stop reply failed: ${safeError(error)}`))
      return
    }

    const generation = this.generation
    void this.runs.enqueue(
      conversationId,
      run => this.processMessage(message, text, imageAttachments, generation, run)
    ).catch(() => {})
  }

  private dispatchInteraction(event: QQButtonEvent): void {
    const client = this.client
    if (!client) return
    const parsed = parseQQPermissionCallback(event.data.resolved.button_data)
    if (!parsed) return
    const route = this.permissionRoutes.get(parsed.permissionId)
    const authorized = isQQPermissionCallbackAuthorized(route, event, this.config.allowedUserIds)
    const accepted = authorized && this.permissions.respond(parsed.permissionId, parsed.allowed)
    void client.acknowledgeInteraction(event.id, accepted ? 0 : 4)
      .catch(error => log('warn', `QQ interaction ACK failed: ${safeError(error)}`))
  }

  private async processMessage(
    message: QQMessage,
    text: string,
    imageAttachments: QQImageAttachment[],
    generation: number,
    run: BotRunContext
  ): Promise<void> {
    const client = this.client
    if (!client || generation !== this.generation || this.controller?.signal.aborted) return
    const response = new QQResponseStream(client, message.replyTarget)
    const permissionPresenter = new QQPermissionPresenter(
      client,
      message.replyTarget,
      message.senderId,
      route => this.permissionRoutes.set(route.permissionId, route),
      permissionId => this.permissionRoutes.delete(permissionId)
    )
    try {
      const senderName = message.senderName || message.senderId
      const images = await this.downloadImages(imageAttachments, run.signal)
      const conversationLabel = message.kind === 'group' ? `${senderName}:` : undefined
      await this.agent.handle({
        channel: this.channel,
        accountId: client.appId,
        conversationId: qqConversationId(message),
        conversationTitle: qqConversationTitle(message),
        senderId: message.senderId,
        senderName,
        text: conversationLabel ? `${conversationLabel} ${text}`.trim() : text,
        images: images.length > 0 ? images : undefined,
        approveMode: this.config.approveMode,
        signal: run.signal,
        events: combineAgentEventSinks(this.agentEvents, response.events),
        permissionPresenters: [permissionPresenter],
        permissionTimeoutMs: 10 * 60 * 1000,
        onSessionReady: run.onSessionReady
      })
      await response.flush()
    } catch (error) {
      await response.flush()
      if (error instanceof AgentAbortedError) throw error
      log('error', `QQ message failed: ${safeError(error)}`)
      await client.sendText(message.replyTarget, `Error: ${safeError(error)}`)
        .catch(sendError => log('warn', `QQ error reply failed: ${safeError(sendError)}`))
      throw error
    }
  }

  private async downloadImages(attachments: QQImageAttachment[], signal: AbortSignal): Promise<string[]> {
    const images: string[] = []
    if (attachments.length === 0) return images
    const fetchImpl = this.getFetch()
    for (const attachment of attachments.slice(0, MAX_IMAGES)) {
      try {
        const response = await fetchImpl(normalizeAttachmentUrl(attachment.url), { signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const declared = Number(response.headers.get('content-length') || 0)
        if (declared > MAX_IMAGE_BYTES) throw new Error(`image is too large (${declared} bytes)`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`image is too large (${bytes.byteLength} bytes)`)
        images.push(`data:${imageMime(attachment)};base64,${Buffer.from(bytes).toString('base64')}`)
      } catch (error) {
        if (isAbort(error)) break
        log('warn', `QQ image download failed: ${safeError(error)}`)
      }
    }
    return images
  }
}

interface QQImageAttachment {
  url: string
  contentType: string
  filename?: string
}

function collectImageAttachments(message: QQMessage): QQImageAttachment[] {
  const all = [
    ...(message.attachments || []),
    ...(message.msgElements || []).flatMap(element => element.attachments || [])
  ]
  const seen = new Set<string>()
  return all.filter(attachment => {
    if (!attachment.url || seen.has(attachment.url) || !isImageAttachment(attachment.content_type, attachment.filename)) return false
    seen.add(attachment.url)
    return true
  }).map(attachment => ({
    url: attachment.url,
    contentType: attachment.content_type,
    filename: attachment.filename
  }))
}

function isImageAttachment(contentType: string, filename?: string): boolean {
  return contentType.toLowerCase().startsWith('image/')
    || contentType.toLowerCase() === 'image'
    || /\.(?:png|jpe?g|webp|gif)$/i.test(filename || '')
}

function imageMime(attachment: QQImageAttachment): string {
  const type = attachment.contentType.toLowerCase()
  if (/^image\/(?:png|jpeg|webp|gif)$/.test(type)) return type
  const extension = /\.(png|jpe?g|webp|gif)$/i.exec(attachment.filename || '')?.[1]?.toLowerCase()
  return extension === 'jpg' ? 'image/jpeg' : `image/${extension || 'jpeg'}`
}

function normalizeAttachmentUrl(url: string): string {
  const normalized = url.startsWith('//') ? `https:${url}` : url
  const parsed = new URL(normalized)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('unsupported attachment URL')
  return parsed.toString()
}

function qqConversationId(message: QQMessage): string {
  return message.kind === 'group'
    ? `group:${message.groupOpenid || message.replyTarget.targetId}:${message.senderId}`
    : `c2c:${message.senderId}`
}

function qqConversationTitle(message: QQMessage): string {
  if (message.kind === 'group') return `QQ 群 · ${shortId(message.groupOpenid || message.replyTarget.targetId)}`
  return `QQ · ${message.senderName || shortId(message.senderId)}`
}

function shortId(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`
}

function validateQQConfig(config: QQBotConfig): void {
  if (!config.appId) throw new Error('QQ Bot AppID is required.')
  if (!config.appSecret) throw new Error('QQ Bot AppSecret is required.')
}

function createReadySignal(client: QQClient): Promise<void> {
  return new Promise(resolve => client.onReady(resolve))
}

function waitUntilReady(ready: Promise<void>, running: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`QQ Bot connection timed out after ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs)
  })
  return Promise.race([
    ready,
    running.then(() => { throw new Error('QQ Bot gateway stopped before becoming ready.') }),
    timeout
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error instanceof AgentAbortedError)
}
