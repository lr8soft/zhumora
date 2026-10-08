import type { AppSettings } from '@shared/types'
import { DEFAULT_AVATAR_WINDOW_SIZE } from '@shared/avatarWindow'
import { DEFAULT_MCP_SERVER_SETTINGS } from '@shared/mcpServer'
import { DEFAULT_BBS_CONFIG } from '@shared/bbs'
import { DEFAULT_SUBAGENTS_ENABLED } from '@shared/subagents'

/** Initial UI projection before main settings load; each draft gets fresh collections. */
export function initialSettingsProjection(): AppSettings {
  return {
    subagentsEnabled: DEFAULT_SUBAGENTS_ENABLED, subagentModel: null,
    providers: [], mcpServers: [], mcpServer: { ...DEFAULT_MCP_SERVER_SETTINGS },
    telegramBot: { enabled: false, token: '', allowedUserIds: [], approveMode: 'manual' },
    qqBot: { enabled: false, appId: '', appSecret: '', allowedUserIds: [], approveMode: 'manual' },
    skills: [], activeProviderId: null, workspacePath: '',
    avatarModels: [], defaultAvatarModelId: null, avatarWindowSize: { ...DEFAULT_AVATAR_WINDOW_SIZE },
    ttsModels: [], defaultTtsModelId: null, bbs: { ...DEFAULT_BBS_CONFIG }
  }
}
