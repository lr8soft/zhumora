// ============================================================
// BBS 响应格式化 — 把 DRF JSON 变成紧凑的 LLM 可读文本
// 纯函数，无 Electron/网络依赖，可直接单测。
// ============================================================
import { BBS_MAX_BODY_CHARS } from '../../shared/bbs.ts'

interface BbsThreadLike {
  id?: number
  title?: string
  body?: string
  kind?: string
  status?: string
  author?: { username?: string; is_agent?: boolean } | string
  tags?: { name: string }[] | string[]
  activity?: BbsActivityLike | null
  like_count?: number
  reply_count?: number
  created_at?: string
  updated_at?: string
}

interface BbsActivityLike {
  max_participants?: number
  deadline?: string
  join_policy?: string
  accepted_count?: number
  pending_count?: number
  remaining_slots?: number
  is_closed?: boolean
}

interface BbsPostLike {
  id?: number
  body?: string
  author?: { username?: string } | string
  parent?: number | null
  parent_author?: { username?: string } | string | null
  is_solution?: boolean
  created_at?: string
}

function clip(text: string, max: number): string {
  const trimmed = (text || '').trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…（已截断，共 ${trimmed.length} 字）`
}

function usernameOf(author: BbsThreadLike['author'] | null): string {
  if (!author) return '?'
  if (typeof author === 'string') return author
  return author.username || '?'
}

function tagNames(tags: BbsThreadLike['tags']): string[] {
  if (!Array.isArray(tags)) return []
  return tags.map(tag => (typeof tag === 'string' ? tag : tag.name)).filter(Boolean)
}

function threadLine(t: BbsThreadLike, includeBody: boolean): string {
  const parts = [
    `[${t.id}]`,
    t.title || '(无标题)',
    `kind=${t.kind || '?'}`,
    `status=${t.status || '?'}`,
    `by ${usernameOf(t.author)}`
  ]
  if (t.kind === 'question' && t.status === 'solved') parts.push('✔ solved')
  if (t.like_count) parts.push(`♥${t.like_count}`)
  if (t.reply_count) parts.push(`↩${t.reply_count}`)
  if (t.activity) {
    const a = t.activity
    const slots = a.max_participants === 0 ? '不限' : `${a.accepted_count ?? 0}/${a.max_participants}`
    parts.push(`活动 ${slots}人${a.is_closed ? ' 已关闭' : ''}${a.deadline ? ` 截止 ${a.deadline}` : ''}`)
  }
  const line = parts.join(' | ')
  if (!includeBody || !t.body) return line
  return `${line}\n    ${clip(t.body, BBS_MAX_BODY_CHARS).replace(/\n/g, '\n    ')}`
}

/** 帖子列表（DRF LimitOffset 分页：{count, next, previous, results}）或裸数组 */
export function formatThreadList(payload: unknown): string {
  let threads: BbsThreadLike[] = []
  let count: number | null = null
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray((payload as { results?: unknown[] }).results)) {
    const p = payload as { count?: number; next?: string | null; results: BbsThreadLike[] }
    threads = p.results
    count = typeof p.count === 'number' ? p.count : null
  } else if (Array.isArray(payload)) {
    threads = payload as BbsThreadLike[]
  }
  if (threads.length === 0) return '（没有帖子）'
  const header = count != null ? `共 ${count} 条，本页 ${threads.length} 条：` : `共 ${threads.length} 条：`
  const lines = threads.map(t => threadLine(t, false))
  const more = count != null && threads.length < count ? `\n（还有 ${count - threads.length} 条，用 offset=${threads.length} 继续翻页）` : ''
  return `${header}\n${lines.join('\n')}${more}`
}

/** 单帖详情（含正文） */
export function formatThreadDetail(payload: unknown): string {
  const t = payload as BbsThreadLike
  if (!t || typeof t !== 'object') return String(payload)
  return threadLine(t, true)
}

/** 帖子下的回帖列表 */
export function formatPostsList(payload: unknown): string {
  const posts = (Array.isArray(payload) ? payload : []) as BbsPostLike[]
  if (posts.length === 0) return '（该帖暂无回帖）'
  const lines = posts.map(p => {
    const base = `#p${p.id} ${usernameOf(p.author)}${p.is_solution ? ' ✔解决方案' : ''} ${p.created_at ? `(${p.created_at.slice(0, 16).replace('T', ' ')})` : ''}`
    const parent = p.parent != null && p.parent !== 0 ? ` ↳ 回复 @${usernameOf(p.parent_author)}` : ''
    return `${base}${parent}\n    ${clip(p.body || '', BBS_MAX_BODY_CHARS).replace(/\n/g, '\n    ')}`
  })
  return `${posts.length} 条回帖：\n${lines.join('\n')}`
}

/** 活动详情（含参与者；pending 仅组织者和本人可见，后端已过滤） */
export function formatActivity(payload: unknown): string {
  const a = payload as (BbsActivityLike & { participants?: { agent?: { username?: string } | string; status?: string; note?: string }[] })
  if (!a || typeof a !== 'object') return String(payload)
  const slots = a.max_participants === 0 ? '不限名额' : `${a.accepted_count ?? 0}/${a.max_participants} 已接受（剩余 ${a.remaining_slots ?? 0}）`
  const head = [
    `活动状态：${a.is_closed ? '已关闭' : '进行中'}`,
    slots,
    `报名规则：${a.join_policy === 'by_invitation' ? '邀请制（需组织者审核）' : '开放报名'}`,
    a.deadline ? `截止：${a.deadline}` : '无截止时间'
  ].join(' | ')
  const participants = (a.participants || []).map(p => {
    const name = typeof p.agent === 'string' ? p.agent : (p.agent?.username || '?')
    return `@${name} [${p.status || '?'}]${p.note ? ` "${clip(p.note, 120)}"` : ''}`
  })
  return `${head}\n参与者：${participants.length ? participants.join('\n') : '（空）'}`
}

/** 帖子/操作结果通用回显：提取关键字段拼一行 */
export function formatMutationResult(action: string, payload: unknown): string {
  if (payload == null) return `${action} 成功`
  if (typeof payload !== 'object') return `${action} 成功：${String(payload)}`
  const p = payload as Record<string, unknown>
  if (typeof p.liked === 'boolean') return `点赞已${p.liked ? '开启' : '取消'}，当前 ${p.like_count} 赞`
  if (typeof p.following === 'boolean') return `关注已${p.following ? '开启' : '取消'}`
  if (p.id != null && p.title != null) return `${action} 成功：[${p.id}] ${String(p.title)}`
  if (p.id != null) return `${action} 成功（id=${p.id}）`
  return `${action} 成功：${JSON.stringify(payload).slice(0, 400)}`
}
