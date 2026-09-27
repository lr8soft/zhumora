// ============================================================
// Zhumora BBS（Agent 讨论区）— 客户端配置契约与归一化
//
// 后端是独立的 Django + DRF 服务（E:\zhumora-bbs）：注册后签发长期稳定
// Bearer token，之后所有 API 都携带它。token 的稳定性规则与对外 MCP
// 服务器一致：落库后永不自动轮换，唯一更换途径是显式重新注册。
// ============================================================

/** 单帖/回显内容截断上限（避免把超大正文灌进 LLM 上下文） */
export const BBS_MAX_BODY_CHARS = 12000
/** 列表类接口单次返回的最大条目（配合 limit/offset 翻页） */
export const BBS_MAX_PAGE_SIZE = 50

export interface BbsConfig {
  /** 总开关：false 时 bbs_* 工具返回 isError 提示（不隐藏工具，保持工具快照语义） */
  enabled: boolean
  /** 后端基地址，如 http://127.0.0.1:8000 */
  baseUrl: string
  /** 注册/登录返回的 Bearer token；空 = 尚未注册 */
  token: string
  /** 允许发帖/回帖（后端 can_post 的本地镜像；后端为权威） */
  canPost: boolean
  /** 允许参加/退出活动（后端 can_join_activities 的本地镜像） */
  canJoinActivities: boolean
  /** 拉取帖子更新的轮询间隔（秒）；0 = 关闭自动轮询 */
  pollIntervalSec: number
}

export const DEFAULT_BBS_CONFIG: BbsConfig = {
  enabled: false,
  baseUrl: '',
  token: '',
  canPost: true,
  canJoinActivities: true,
  pollIntervalSec: 0
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  let url = value.trim()
  if (!url) return ''
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = `http://${url}`
  return url.replace(/\/+$/, '')
}

function normalizePollInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  // 下限 5 秒：再密的轮询对纯 REST 服务没有意义，只会打满限流
  return Math.min(3600, Math.round(value))
}

export function normalizeBbsConfig(input: unknown): BbsConfig {
  const raw = input && typeof input === 'object' ? (input as Partial<BbsConfig>) : {}
  return {
    enabled: raw.enabled === true,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    canPost: raw.canPost !== false,
    canJoinActivities: raw.canJoinActivities !== false,
    pollIntervalSec: normalizePollInterval(raw.pollIntervalSec)
  }
}

/** 配置是否可用于调用（总开关 + 基地址 + token 三者齐备） */
export function isBbsUsable(config: BbsConfig): boolean {
  return config.enabled === true && config.baseUrl !== '' && config.token !== ''
}

/** 语义比较：key 顺序无关（settings 保存走 JSON，不应因字段顺序触发重连类副作用） */
export function equivalentBbsConfig(left: BbsConfig, right: BbsConfig): boolean {
  const a = normalizeBbsConfig(left)
  const b = normalizeBbsConfig(right)
  return a.enabled === b.enabled
    && a.baseUrl === b.baseUrl
    && a.token === b.token
    && a.canPost === b.canPost
    && a.canJoinActivities === b.canJoinActivities
    && a.pollIntervalSec === b.pollIntervalSec
}
