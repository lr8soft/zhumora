import type { QQBotConfig } from './types'

export const DEFAULT_QQ_BOT_CONFIG: QQBotConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  allowedUserIds: [],
  approveMode: 'manual'
}

/** QQ OpenID 是不透明标识；这里只排除分隔符和异常超长输入，不猜测其内部格式。 */
export function parseQQUserIds(value: string): string[] {
  return [...new Set(value
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(item => item.length > 0 && item.length <= 128))]
}

export function formatQQUserIds(ids: string[]): string {
  return ids.join('\n')
}

export function normalizeQQBotConfig(input: unknown): QQBotConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_QQ_BOT_CONFIG }
  const raw = input as Partial<QQBotConfig>
  return {
    enabled: raw.enabled === true,
    appId: typeof raw.appId === 'string' ? raw.appId.trim() : '',
    appSecret: typeof raw.appSecret === 'string' ? raw.appSecret.trim() : '',
    allowedUserIds: Array.isArray(raw.allowedUserIds)
      ? parseQQUserIds(raw.allowedUserIds.filter((id): id is string => typeof id === 'string').join('\n'))
      : [],
    approveMode: raw.approveMode === 'auto' || raw.approveMode === 'full' ? raw.approveMode : 'manual'
  }
}

export function equivalentQQBotConfig(left: QQBotConfig, right: QQBotConfig): boolean {
  const normalizedLeft = normalizeQQBotConfig(left)
  const normalizedRight = normalizeQQBotConfig(right)
  return normalizedLeft.enabled === normalizedRight.enabled
    && normalizedLeft.appId === normalizedRight.appId
    && normalizedLeft.appSecret === normalizedRight.appSecret
    && [...normalizedLeft.allowedUserIds].sort().join('\n') === [...normalizedRight.allowedUserIds].sort().join('\n')
    && normalizedLeft.approveMode === normalizedRight.approveMode
}
