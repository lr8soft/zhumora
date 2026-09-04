import type {
  PermissionPresenter,
  PermissionRequest,
  PermissionResolution
} from '../agent/permissionBroker'
import { formatBotPermissionPrompt } from '../bot/permissionPrompt.ts'
import { log } from '../llm/logger.ts'
import type { QQClient, QQMessageTarget } from './client'

const PROMPT_ARGUMENT_LIMIT = 1200

const APPROVE_REPLIES = new Set(['y', 'yes', '允许', '同意', '确认', '批准'])
const DENY_REPLIES = new Set(['n', 'no', 'deny', '拒绝', '不同意', '取消'])

export interface QQPermissionRoute {
  permissionId: string
  senderId: string
  conversationId: string
}

/**
 * QQ 没有 Telegram 的 callback_query 独立通道，按钮消息又依赖平台额外开通的
 * 键盘模板权限，因此确认走纯文本：Agent 挂起时用户在 QQ 里回复 y / n。
 */
export class QQPermissionPresenter implements PermissionPresenter {
  private readonly pending = new Set<string>()
  private readonly client: QQClient
  private readonly target: QQMessageTarget
  private readonly senderId: string
  private readonly conversationId: string
  private readonly register: (route: QQPermissionRoute) => void
  private readonly unregister: (permissionId: string) => void

  constructor(
    client: QQClient,
    target: QQMessageTarget,
    senderId: string,
    conversationId: string,
    register: (route: QQPermissionRoute) => void,
    unregister: (permissionId: string) => void
  ) {
    this.client = client
    this.target = target
    this.senderId = senderId
    this.conversationId = conversationId
    this.register = register
    this.unregister = unregister
  }

  async present(request: PermissionRequest): Promise<void> {
    this.pending.add(request.id)
    this.register({
      permissionId: request.id,
      senderId: this.senderId,
      conversationId: this.conversationId
    })
    try {
      await this.client.sendText(this.target, formatQQPermissionPrompt(request))
    } catch (error) {
      // Surface it: a silently dropped prompt leaves the Agent hanging with no
      // way for the user to answer.
      log('error', `QQ permission prompt failed to send (${request.toolName}): ${safeError(error)}`)
      this.unregister(request.id)
      this.pending.delete(request.id)
      throw error
    }
  }

  resolve(request: PermissionRequest, _resolution: PermissionResolution): void {
    if (!this.pending.delete(request.id)) return
    this.unregister(request.id)
  }
}

export function formatQQPermissionPrompt(request: PermissionRequest): string {
  return [
    formatBotPermissionPrompt(request, PROMPT_ARGUMENT_LIMIT),
    '',
    '回复 y 允许执行，回复 n 拒绝。'
  ].join('\n')
}

/** 只接受整条消息就是一个确认词，避免把正常发言误判成批准。 */
export function parseQQPermissionReply(text: string): 'approve' | 'deny' | null {
  const normalized = text.trim().toLowerCase().replace(/[。！!？?~～\s]+$/g, '')
  if (APPROVE_REPLIES.has(normalized)) return 'approve'
  if (DENY_REPLIES.has(normalized)) return 'deny'
  return null
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}
