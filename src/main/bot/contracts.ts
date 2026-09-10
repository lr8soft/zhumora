import type { AutoApproveMode } from '../../shared/types'
import type { AgentEventSink } from '../agent/persistedCallbacks'
import type { PermissionPresenter } from '../agent/permissionBroker'

export interface BotSessionMessage {
  channel: string
  accountId: string
  conversationId: string
  conversationTitle: string
  senderId: string
  senderName: string
  text: string
  /** 用户消息附带的图片（base64 data URL），进入 LLM 多模态上下文 */
  images?: string[]
  approveMode: AutoApproveMode
  signal: AbortSignal
  events: AgentEventSink
  permissionPresenters?: PermissionPresenter[]
  permissionTimeoutMs?: number
}

export interface BotSessionResult {
  sessionId: string
}

/** Platform-neutral lifecycle surface consumed by the application composition root. */
export interface BotPlatformRuntime {
  readonly channel: string
  stop(): Promise<void>
}

/** Configuration extension implemented by each concrete platform adapter. */
export interface BotPlatformService<TConfig> extends BotPlatformRuntime {
  configure(config: TConfig): Promise<void>
}
