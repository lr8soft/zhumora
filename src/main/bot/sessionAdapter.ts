import type { Session } from '../../shared/types.ts'
import type { SessionService } from '../agent/sessionService.ts'
import type { BotSessionMessage, BotSessionResult } from './contracts.ts'

interface BotSessionAdapterDependencies {
  sessions: SessionService
}

/** Maps an external Bot conversation to a session, then delegates to the unified Session API. */
export class BotSessionAdapter {
  private readonly deps: BotSessionAdapterDependencies

  constructor(deps: BotSessionAdapterDependencies) {
    this.deps = deps
  }

  resolve(message: BotSessionMessage): Session {
    return this.deps.sessions.resolveExternalSession(
      message.channel,
      message.accountId,
      message.conversationId,
      message.conversationTitle
    )
  }

  async handle(message: BotSessionMessage): Promise<BotSessionResult> {
    const session = this.resolve(message)
    const run = await this.deps.sessions.sendMessage({
      sessionId: session.id,
      message: { text: message.text, images: message.images },
      approveMode: message.approveMode,
      signal: message.signal,
      localEvents: message.events,
      permissionPresenters: message.permissionPresenters,
      permissionTimeoutMs: message.permissionTimeoutMs,
      sourcePrompt: message.sourcePrompt
        ?? `You are replying through ${message.channel} to ${message.senderName}. Use plain text and keep the response concise.`,
      inputSource: 'external'
    })
    // handle.completion 有界（见 SessionRunHandle 注释）：卡死的 runner 不会
    // 永久挂起 Bot FIFO；中止语义与错误语义由其 reject（AgentAbortedError /
    // 原始错误）保持不变。
    await run.completion
    return { sessionId: session.id }
  }
}
