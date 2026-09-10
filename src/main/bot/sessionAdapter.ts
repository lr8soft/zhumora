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
      sourcePrompt: `You are replying through ${message.channel} to ${message.senderName}. Use plain text and keep the response concise.`,
      inputSource: 'external'
    })
    await run.completion
    return { sessionId: session.id }
  }
}
