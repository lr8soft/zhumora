import type { AppSettings } from '../../shared/types.ts'
import { normalizeQQBotConfig } from '../../shared/qq.ts'
import { normalizeTelegramBotConfig } from '../../shared/telegram.ts'
import { normalizeAvatarModels, resolveDefaultAvatarModelId } from '../../shared/avatar.ts'
import { normalizeAvatarWindowSize } from '../../shared/avatarWindow.ts'
import { normalizeTtsModels, resolveDefaultTtsModelId } from '../../shared/tts.ts'
import { normalizeBrowserTarget, normalizeCustomBrowserPath } from '../../shared/browser.ts'
import { normalizeBbsConfig } from '../../shared/bbs.ts'
import { ensureMcpServerToken, normalizeMcpServerSettings } from '../../shared/mcpServer.ts'
import { normalizeReasoningDialect } from '../../shared/reasoning.ts'
import { DEFAULT_SUBAGENTS_ENABLED, normalizeSubagentsEnabled, normalizeSubagentModel } from '../../shared/subagents.ts'

export const SETTINGS_SCHEMA_VERSION = 12

export function defaultSettings(workspacePath: string): AppSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    providers: [
      {
        id: 'zhuminet-default',
        name: '煮米 API',
        baseUrl: 'https://api.zhuminet.com/v1',
        apiKey: '',
        defaultModel: '',
        enabled: true
      }
    ],
    mcpServers: [],
    mcpServer: normalizeMcpServerSettings(undefined),
    telegramBot: normalizeTelegramBotConfig(undefined),
    qqBot: normalizeQQBotConfig(undefined),
    skills: [],
    activeProviderId: 'zhuminet-default',
    workspacePath,
    memoryEnabled: true,
    subagentsEnabled: DEFAULT_SUBAGENTS_ENABLED,
    subagentModel: null,
    language: 'auto',
    maxRetries: 5,
    maxRounds: 20,
    browserMode: 'local',
    browserTarget: 'chrome',
    customBrowserPath: '',
    avatarModels: [],
    defaultAvatarModelId: null,
    avatarWindowSize: normalizeAvatarWindowSize(undefined),
    ttsModels: [],
    defaultTtsModelId: null,
    bbs: normalizeBbsConfig(undefined)
  }
}

/**
 * Provider 列表的结构归一化：目前只有思考强度方言需要收口（未知值回落 'auto'）。
 * 其余字段保持原样——它们的默认值由各消费方（上下文窗口探测、模型列表、
 * 用量统计）决定，在这里补默认值会形成第二份默认值定义。
 */
function normalizeProviders(input: unknown): AppSettings['providers'] | null {
  if (!Array.isArray(input)) return null
  return input.map(provider => {
    if (!provider || typeof provider !== 'object') return provider
    return {
      ...provider,
      reasoningDialect: normalizeReasoningDialect((provider as AppSettings['providers'][number]).reasoningDialect)
    }
  })
}

/** JSON blob 的前向迁移与默认值合并集中在存储边界。 */
export function normalizeSettings(input: unknown, workspacePath = process.cwd()): AppSettings {
  const defaults = defaultSettings(workspacePath)
  if (!input || typeof input !== 'object') return defaults
  const raw = input as Partial<AppSettings>
  const avatarModels = normalizeAvatarModels(raw.avatarModels)
  const ttsModels = normalizeTtsModels(raw.ttsModels)
  return {
    ...defaults,
    ...raw,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    providers: normalizeProviders(raw.providers) ?? defaults.providers,
    subagentsEnabled: normalizeSubagentsEnabled(raw.subagentsEnabled),
    subagentModel: normalizeSubagentModel(raw.subagentModel),
    mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : defaults.mcpServers,
    mcpServer: ensureMcpServerToken(normalizeMcpServerSettings(raw.mcpServer)),
    telegramBot: normalizeTelegramBotConfig(raw.telegramBot),
    qqBot: normalizeQQBotConfig(raw.qqBot),
    skills: Array.isArray(raw.skills) ? raw.skills : defaults.skills,
    avatarModels,
    avatarWindowSize: normalizeAvatarWindowSize(raw.avatarWindowSize),
    defaultAvatarModelId: resolveDefaultAvatarModelId(avatarModels, raw.defaultAvatarModelId),
    ttsModels,
    defaultTtsModelId: resolveDefaultTtsModelId(ttsModels, raw.defaultTtsModelId),
    bbs: normalizeBbsConfig(raw.bbs),
    browserMode: raw.browserMode === 'headless' ? 'headless' : 'local',
    browserTarget: normalizeBrowserTarget(raw.browserTarget),
    customBrowserPath: normalizeCustomBrowserPath(raw.customBrowserPath),
    // 窗口关闭默认收进托盘后台（用户可显式关回"关闭即退出"）
    backgroundClose: raw.backgroundClose !== false,
    activeProviderId: typeof raw.activeProviderId === 'string' || raw.activeProviderId === null
      ? raw.activeProviderId
      : defaults.activeProviderId,
    workspacePath: typeof raw.workspacePath === 'string' ? raw.workspacePath : defaults.workspacePath
  }
}
