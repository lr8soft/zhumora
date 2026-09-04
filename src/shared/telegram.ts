import type { TelegramBotConfig } from './types'

export const DEFAULT_TELEGRAM_BOT_CONFIG: TelegramBotConfig = {
  enabled: false,
  token: '',
  allowedUserIds: []
}

export function parseTelegramUserIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map(item => item.trim()).filter(item => /^\d+$/.test(item)))]
}

export function formatTelegramUserIds(ids: string[]): string {
  return ids.join('\n')
}

export function normalizeTelegramBotConfig(input: unknown): TelegramBotConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_TELEGRAM_BOT_CONFIG }
  const raw = input as Partial<TelegramBotConfig>
  return {
    enabled: raw.enabled === true,
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    allowedUserIds: Array.isArray(raw.allowedUserIds)
      ? [...new Set(raw.allowedUserIds.filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id)))]
      : []
  }
}

export function equivalentTelegramBotConfig(left: TelegramBotConfig, right: TelegramBotConfig): boolean {
  const normalizedLeft = normalizeTelegramBotConfig(left)
  const normalizedRight = normalizeTelegramBotConfig(right)
  return normalizedLeft.enabled === normalizedRight.enabled
    && normalizedLeft.token === normalizedRight.token
    && [...normalizedLeft.allowedUserIds].sort().join('\n') === [...normalizedRight.allowedUserIds].sort().join('\n')
}
