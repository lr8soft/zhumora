// ============================================================
// Zhumora BBS HTTP 客户端 — 纯传输层
//
// 对应 Django 后端（E:\zhumora-bbs）的 REST API。这里只负责：
// 拼 URL、带 Bearer token、超时控制、把失败归一成 BbsError。
// 响应格式化和业务判断由 format.ts / tools.ts 负责。
// 本模块保持纯传输层：fetch 与配置读取全部经构造参数注入（生产由
// composition / IPC 传入 getFetch 与 settings 闭包），不直接 import
// Electron 相关模块，保证单测可在纯 Node 环境运行。
// ============================================================
import type { BbsConfig } from '../../shared/bbs.ts'

export const BBS_TIMEOUT_MS = 15000

export type BbsErrorCode = 'config' | 'network' | 'http'

export class BbsError extends Error {
  code: BbsErrorCode
  status?: number
  detail?: unknown
  constructor(message: string, code: BbsErrorCode, status?: number, detail?: unknown) {
    super(message)
    this.name = 'BbsError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

export interface BbsRegisterResult {
  /** 仅注册新账号成功时为 true；409 冲突时为 false（应改用 login） */
  created: boolean
  /** 注册/登录成功时返回的 Bearer token */
  token: string | null
  profile: BbsProfile | null
  error?: string
}

export interface BbsProfile {
  id: number
  username: string
  display_name: string
  description: string
  can_post: boolean
  can_join_activities: boolean
  is_active: boolean
  last_seen_at: string | null
  created_at: string
}

/** DRF LimitOffset 分页包络（listThreads 返回；listFollowing 是裸数组） */
export interface BbsPage<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}

export interface BbsClientLike {
  /** 健康检查（无需 token） */
  health(): Promise<boolean>
  register(username: string, password: string, displayName?: string): Promise<BbsRegisterResult>
  login(username: string, password: string): Promise<BbsRegisterResult>
  me(): Promise<BbsProfile>
  patchProfile(patch: { display_name?: string; description?: string; can_post?: boolean; can_join_activities?: boolean }): Promise<BbsProfile>
  listThreads(params: BbsListThreadsParams): Promise<BbsPage<unknown>>
  getThread(id: number): Promise<unknown>
  createThread(payload: BbsCreateThreadPayload): Promise<unknown>
  patchThread(id: number, payload: BbsThreadPatchPayload): Promise<unknown>
  deleteThread(id: number): Promise<void>
  toggleLike(id: number): Promise<{ liked: boolean; like_count: number }>
  toggleFollow(id: number): Promise<{ following: boolean }>
  listFollowing(): Promise<unknown[]>
  markSolved(id: number, solutionPostId?: number): Promise<unknown>
  listPosts(threadId: number): Promise<unknown[]>
  createPost(threadId: number, body: string, parentId?: number): Promise<unknown>
  deletePost(threadId: number, postId: number): Promise<void>
  getActivity(threadId: number): Promise<unknown>
  joinActivity(threadId: number, note?: string): Promise<unknown>
  leaveActivity(threadId: number): Promise<void>
}

export interface BbsListThreadsParams {
  kind?: string
  status?: string
  tag?: string
  author?: string
  q?: string
  /** 'me' = 只看我关注的帖子 */
  followingMe?: boolean
  /** ISO 8601 游标：只返回该时刻之后有变化的帖子 */
  updatedAfter?: string
  order?: string
  limit?: number
  offset?: number
}

export interface BbsCreateThreadPayload {
  title: string
  body?: string
  kind: 'question' | 'share' | 'activity'
  tags?: string[]
  /** kind=activity 时必填：deadline（ISO 8601）、max_participants（0=不限）、join_policy（open|by_invitation） */
  activity?: { deadline: string; max_participants?: number; join_policy?: 'open' | 'by_invitation' }
}

export interface BbsThreadPatchPayload {
  title?: string
  body?: string
  status?: string
  tags?: string[]
}

export interface BbsClientOptions {
  /** 每次请求现读配置（settings 保存后即时生效，不缓存 token） */
  getConfig: () => BbsConfig
  /** 每次请求现取 fetch（与 getFetch 语义一致：系统证书开关切换即时生效） */
  getFetch: () => typeof fetch
}

/** 从 DRF 错误响应里提取可读原因（detail / 字段错误列表 / 兜底） */
export function extractBbsErrorDetail(body: unknown): string {
  if (typeof body === 'string' && body) return body.slice(0, 500)
  if (!body || typeof body !== 'object') return ''
  const obj = body as Record<string, unknown>
  if (typeof obj.detail === 'string') return obj.detail
  // 字段校验错误：取第一个字段的第一个消息
  const values = Object.values(obj)
  for (const value of values) {
    if (Array.isArray(value)) {
      const first = value.find(item => typeof item === 'string')
      if (typeof first === 'string') return String(first)
    } else if (typeof value === 'string') {
      return value
    }
  }
  try {
    return JSON.stringify(body).slice(0, 500)
  } catch {
    return ''
  }
}

/**
 * BBS 配置闭包 + 可用性检查：集中把"未启用 / 未注册 / 未填地址"
 * 归一成带修复指引的错误，工具层不再各自拼提示文案。
 */
function requireUsableConfig(getConfig: () => BbsConfig, action: string): BbsConfig {
  const config = getConfig()
  if (!config.enabled) {
    throw new BbsError(`BBS 讨论区未启用（${action} 不可用）。请在 设置 → 讨论区 打开开关并注册账号。`, 'config')
  }
  if (!config.baseUrl) {
    throw new BbsError('BBS 讨论区未配置服务器地址。请在 设置 → 讨论区 填写 Base URL。', 'config')
  }
  if (!config.token) {
    throw new BbsError('BBS 讨论区尚未注册账号。请在 设置 → 讨论区 完成注册后重试。', 'config')
  }
  return config
}

function buildUrl(config: BbsConfig, path: string, params?: Record<string, unknown>): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, config.baseUrl)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

export function createBbsClient({ getConfig, getFetch }: BbsClientOptions): BbsClientLike {
  async function request(
    method: string,
    path: string,
    options: { params?: Record<string, unknown>; body?: unknown; auth?: boolean } = {}
  ): Promise<unknown> {
    const config = options.auth === false ? getConfig() : requireUsableConfig(getConfig, '请求')
    const url = buildUrl(config, path, options.params)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (options.auth !== false && config.token) headers['Authorization'] = `Bearer ${config.token}`
    const fetchFn = getFetch()

    let response: Response
    try {
      response = await fetchFn(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(BBS_TIMEOUT_MS)
      })
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } })?.cause
      const reason = cause?.code || cause?.message || (error instanceof Error ? error.message : String(error))
      throw new BbsError(`BBS 服务器无法连接（${url}）：${reason}`, 'network')
    }

    const text = await response.text()
    let parsed: unknown = null
    if (text) {
      try { parsed = JSON.parse(text) } catch { parsed = text }
    }
    if (!response.ok) {
      const detail = extractBbsErrorDetail(parsed)
      const message = `BBS 请求失败（${method} ${path} → HTTP ${response.status}）${detail ? `：${detail}` : ''}`
      throw new BbsError(message, 'http', response.status, parsed)
    }
    return parsed
  }

  return {
    async health() {
      const config = getConfig()
      if (!config.baseUrl) return false
      try {
        const response = await getFetch()(buildUrl(config, '/healthz'), {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        })
        return response.ok
      } catch {
        return false
      }
    },

    async register(username, password, displayName) {
      const config = getConfig()
      if (!config.baseUrl) return { created: false, token: null, profile: null, error: '请先填写服务器地址' }
      try {
        const data = (await request('POST', '/api/agent/register/', {
          body: { username, password, display_name: displayName || undefined },
          auth: false
        })) as Record<string, unknown>
        return { created: true, token: typeof data.agent_token === 'string' ? data.agent_token : null, profile: data as unknown as BbsProfile }
      } catch (error) {
        if (error instanceof BbsError && error.status === 409) {
          // 账号已存在：token 永不回显，只能走 login 换回
          return { created: false, token: null, profile: null, error: extractBbsErrorDetail(error.detail) || '账号已存在，请改用登录' }
        }
        return { created: false, token: null, profile: null, error: error instanceof Error ? error.message : String(error) }
      }
    },

    async login(username, password) {
      const config = getConfig()
      if (!config.baseUrl) return { created: false, token: null, profile: null, error: '请先填写服务器地址' }
      try {
        const data = (await request('POST', '/api/agent/login/', {
          body: { username, password },
          auth: false
        })) as Record<string, unknown>
        return { created: false, token: typeof data.agent_token === 'string' ? data.agent_token : null, profile: data as unknown as BbsProfile }
      } catch (error) {
        return { created: false, token: null, profile: null, error: error instanceof Error ? error.message : String(error) }
      }
    },

    async me() {
      return (await request('GET', '/api/agent/me/')) as BbsProfile
    },

    async patchProfile(patch) {
      return (await request('POST', '/api/agent/profile/patch/', { body: patch })) as BbsProfile
    },

    async listThreads(params) {
      const query: Record<string, unknown> = {
        kind: params.kind,
        status: params.status,
        tag: params.tag,
        author: params.author,
        q: params.q,
        following: params.followingMe ? 'me' : undefined,
        updated_after: params.updatedAfter,
        order: params.order,
        limit: params.limit,
        offset: params.offset
      }
      return (await request('GET', '/api/threads/', { params: query })) as BbsPage<unknown>
    },

    async getThread(id) {
      return request('GET', `/api/threads/${id}/`)
    },

    async createThread(payload) {
      return request('POST', '/api/threads/', { body: payload })
    },

    async patchThread(id, payload) {
      return request('PATCH', `/api/threads/${id}/`, { body: payload })
    },

    async deleteThread(id) {
      await request('DELETE', `/api/threads/${id}/`)
    },

    async toggleLike(id) {
      return (await request('POST', `/api/threads/${id}/like/`)) as { liked: boolean; like_count: number }
    },

    async toggleFollow(id) {
      return (await request('POST', `/api/threads/${id}/follow/`)) as { following: boolean }
    },

    async listFollowing() {
      return (await request('GET', '/api/threads/following/')) as unknown[]
    },

    async markSolved(id, solutionPostId) {
      return request('POST', `/api/threads/${id}/mark-solved/`, { body: solutionPostId != null ? { solution_post_id: solutionPostId } : {} })
    },

    async listPosts(threadId) {
      return (await request('GET', `/api/threads/${threadId}/posts/`)) as unknown[]
    },

    async createPost(threadId, body, parentId) {
      return request('POST', `/api/threads/${threadId}/posts/`, { body: { body, parent_id: parentId ?? null } })
    },

    async deletePost(threadId, postId) {
      await request('DELETE', `/api/threads/${threadId}/posts/${postId}/`)
    },

    async getActivity(threadId) {
      return request('GET', `/api/threads/${threadId}/activity/`)
    },

    async joinActivity(threadId, note) {
      return request('POST', `/api/threads/${threadId}/activity/join/`, { body: { note: note || '' } })
    },

    async leaveActivity(threadId) {
      await request('POST', `/api/threads/${threadId}/activity/leave/`)
    }
  }
}

