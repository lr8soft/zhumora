import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs'
import type {
  PermissionPresenter,
  PermissionRequest,
  PermissionResolution
} from '../agent/permissionBroker'
import { formatBotPermissionPrompt } from '../bot/permissionPrompt.ts'
import type { QQButtonEvent, QQClient, QQMessageTarget } from './client'

const CALLBACK_PREFIX = 'zhp'

export interface QQPermissionRoute {
  permissionId: string
  senderId: string
  scope: QQMessageTarget['scope']
  targetId: string
}

export class QQPermissionPresenter implements PermissionPresenter {
  private readonly pending = new Set<string>()
  private readonly client: QQClient
  private readonly target: QQMessageTarget
  private readonly senderId: string
  private readonly register: (route: QQPermissionRoute) => void
  private readonly unregister: (permissionId: string) => void

  constructor(
    client: QQClient,
    target: QQMessageTarget,
    senderId: string,
    register: (route: QQPermissionRoute) => void,
    unregister: (permissionId: string) => void
  ) {
    this.client = client
    this.target = target
    this.senderId = senderId
    this.register = register
    this.unregister = unregister
  }

  async present(request: PermissionRequest): Promise<void> {
    this.pending.add(request.id)
    this.register({
      permissionId: request.id,
      senderId: this.senderId,
      scope: this.target.scope,
      targetId: this.target.targetId
    })
    try {
      await this.client.sendTextWithKeyboard(
        this.target,
        formatBotPermissionPrompt(request, 1200),
        permissionKeyboard(request.id)
      )
    } catch (error) {
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

export function qqPermissionCallbackData(permissionId: string, allowed: boolean): string {
  return `${CALLBACK_PREFIX}:${permissionId}:${allowed ? '1' : '0'}`
}

export function parseQQPermissionCallback(data: string | undefined): { permissionId: string; allowed: boolean } | null {
  if (!data) return null
  const match = /^zhp:([A-Za-z0-9_-]+):([01])$/.exec(data)
  return match ? { permissionId: match[1], allowed: match[2] === '1' } : null
}

export function isQQPermissionCallbackAuthorized(
  route: QQPermissionRoute | undefined,
  event: QQButtonEvent,
  allowedUserIds: string[]
): boolean {
  if (!route) return false
  const senderId = event.user_openid || event.group_member_openid || event.data.resolved.user_id
  const targetId = route.scope === 'c2c'
    ? (event.user_openid || event.data.resolved.user_id)
    : event.group_openid
  return senderId === route.senderId
    && targetId === route.targetId
    && allowedUserIds.includes(route.senderId)
}

function permissionKeyboard(permissionId: string): InlineKeyboard {
  return {
    content: {
      rows: [{
        buttons: [
          permissionButton(permissionId, true),
          permissionButton(permissionId, false)
        ]
      }]
    }
  }
}

function permissionButton(permissionId: string, allowed: boolean) {
  const label = allowed ? '允许' : '拒绝'
  return {
    id: `zh-${allowed ? 'allow' : 'deny'}-${permissionId}`,
    render_data: { label, visited_label: allowed ? '已允许' : '已拒绝', style: allowed ? 1 : 0 },
    action: {
      type: 2,
      permission: { type: 2 },
      data: qqPermissionCallbackData(permissionId, allowed),
      click_limit: 1
    }
  }
}
