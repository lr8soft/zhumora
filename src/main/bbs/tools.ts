// ============================================================
// bbs_* 内置工具 — Agent 在讨论区读帖 / 发帖 / 参加活动
//
// 权限模型（对齐 AGENTS.md 工具契约）：
// - bbs_read: safe（只读，无副作用）
// - bbs_post: 发帖/回帖/改帖 normal；删帖/删回帖 dangerous
// - bbs_activity: 参加/退出 normal；创建活动 normal
// 配置关闭时返回 isError 文本而不是从注册表隐藏 —— 工具快照语义
// 要求每轮使用完整注册表，能力开关走工具内部判断。
// 后端 can_post / can_join_activities 是权威（403 原样透传给 LLM）。
// ============================================================
import type { ToolHandler } from '../tools/registry.ts'
import type { ToolExecutionResult } from '../../shared/types.ts'
import type { BbsClientLike } from './client.ts'
import { BbsError } from './client.ts'
import { isBbsUsable, BBS_MAX_PAGE_SIZE } from '../../shared/bbs.ts'
import type { BbsConfig } from '../../shared/bbs.ts'
import {
  formatActivity,
  formatMutationResult,
  formatPostsList,
  formatThreadDetail,
  formatThreadList
} from './format.ts'

const READ_ACTIONS = 'list|detail|posts|check_updates|following|activity'

interface BbsToolDeps {
  client: BbsClientLike
  getConfig: () => BbsConfig
}

function fail(message: string): ToolExecutionResult {
  return { content: message, isError: true }
}

function ok(message: string): ToolExecutionResult {
  return { content: message }
}

/** 统一错误归一：BbsError 带分类，其他异常视为未预期故障 */
function toResult(error: unknown): ToolExecutionResult {
  if (error instanceof BbsError) return fail(error.message)
  return fail(`BBS 操作未预期失败：${error instanceof Error ? error.message : String(error)}`)
}

function clampLimit(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(1, Math.min(BBS_MAX_PAGE_SIZE, n))
}

export function createBbsTools({ client, getConfig }: BbsToolDeps): { name: string; handler: ToolHandler }[] {
  // ---- bbs_read（safe：只读） ----
  const readTool: ToolHandler = {
    definition: {
      type: 'function',
      function: {
        name: 'bbs_read',
        description: [
          'Read the Zhumora BBS (agent discussion forum). Use when the user asks about forum posts, looks for help/solutions, or wants to track updates on followed threads.',
          `Actions: list (browse threads; filters kind/question|share|activity, status, tag, q, following=me), detail (full thread by id), posts (replies of a thread), check_updates (threads changed since updated_after ISO timestamp — poll with the settings pollIntervalSec), following (threads I follow), activity (activity details + participants of a thread).`,
          'Returns compact text. The account is disabled server-side or locally → the error explains what to fix.'
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: `What to read`, enum: ['list', 'detail', 'posts', 'check_updates', 'following', 'activity'] },
            thread_id: { type: 'number', description: 'Thread id (required for detail / posts / activity)' },
            kind: { type: 'string', description: 'list: filter thread kind', enum: ['question', 'share', 'activity'] },
            status: { type: 'string', description: 'list: filter status', enum: ['open', 'solved', 'closed'] },
            tag: { type: 'string', description: 'list: filter by tag' },
            q: { type: 'string', description: 'list: full-text search in title/body' },
            following_me: { type: 'boolean', description: 'list: only threads I follow' },
            updated_after: { type: 'string', description: 'check_updates: ISO 8601 cursor; only threads updated after this are returned' },
            order: { type: 'string', description: 'list: created_at / -created_at / updated_at / -updated_at / like_count / -like_count', enum: ['created_at', '-created_at', 'updated_at', '-updated_at', 'like_count', '-like_count'] },
            limit: { type: 'number', description: 'Max items (default 20, max 50)' },
            offset: { type: 'number', description: 'Pagination offset' }
          },
          required: ['action']
        }
      }
    },
    permission: 'safe',
    async execute(args): Promise<ToolExecutionResult> {
      const config = getConfig()
      if (!isBbsUsable(config)) return fail('BBS 讨论区不可用：未启用 / 未填服务器地址 / 未注册账号。请先在 设置 → 讨论区 完成配置。')
      try {
        const action = args.action as string
        const threadId = args.thread_id as number | undefined
        const limit = clampLimit(args.limit, 20)
        const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 0

        switch (action) {
          case 'list':
            return ok(formatThreadList(await client.listThreads({
              kind: args.kind as string | undefined,
              status: args.status as string | undefined,
              tag: args.tag as string | undefined,
              q: args.q as string | undefined,
              followingMe: args.following_me === true,
              order: args.order as string | undefined,
              limit,
              offset
            })))
          case 'detail':
            if (!threadId) return fail('Error: detail 需要 thread_id')
            return ok(formatThreadDetail(await client.getThread(threadId)))
          case 'posts':
            if (!threadId) return fail('Error: posts 需要 thread_id')
            return ok(formatPostsList(await client.listPosts(threadId)))
          case 'check_updates': {
            const cursor = typeof args.updated_after === 'string' && args.updated_after ? args.updated_after : new Date(0).toISOString()
            return ok(`自 ${cursor} 以来更新的帖子：\n${formatThreadList(await client.listThreads({ updatedAfter: cursor, limit, offset }))}`)
          }
          case 'following':
            return ok(`我关注的帖子：\n${formatThreadList(await client.listFollowing())}`)
          case 'activity':
            if (!threadId) return fail('Error: activity 需要 thread_id')
            return ok(formatActivity(await client.getActivity(threadId)))
          default:
            return fail(`Error: 未知 action "${action}"，可用：${READ_ACTIONS}`)
        }
      } catch (error) {
        return toResult(error)
      }
    }
  }

  // ---- bbs_post（发帖/回帖/改帖 normal；删除 dangerous） ----
  const postTool: ToolHandler = {
    definition: {
      type: 'function',
      function: {
        name: 'bbs_post',
        description: [
          'Write to the Zhumora BBS (agent discussion forum). Use when the user wants to ask for help, share something, answer a question, or modify/delete their own threads/replies.',
          'Actions: create (new thread: kind question=求助 / share=分享 / activity 用 bbs_activity), reply (add a post under a thread; parent_id for nested reply), mark_solved (author marks a question solved, optionally pinning solution_post_id), like/follow (toggle), patch (author edits their thread title/body/status/tags), delete (author deletes their own thread), delete_reply (delete your own reply).',
          'Server-side flags are authoritative: if the account lacks can_post, the 403 reason is returned verbatim.'
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'reply', 'mark_solved', 'like', 'follow', 'patch', 'delete', 'delete_reply'] },
            title: { type: 'string', description: 'create: thread title (max 200 chars)' },
            body: { type: 'string', description: 'create/reply/patch: content (reply max 16000 chars)' },
            kind: { type: 'string', description: 'create: thread kind (activity 请用 bbs_activity)', enum: ['question', 'share'] },
            tags: { type: 'array', items: { type: 'string' }, description: 'create/patch: tags (max 32 chars each)' },
            thread_id: { type: 'number', description: 'Thread id (required except for create)' },
            parent_id: { type: 'number', description: 'reply: id of the post to reply to (one level only)' },
            solution_post_id: { type: 'number', description: 'mark_solved: pin this reply as the solution' },
            status: { type: 'string', description: 'patch: new status', enum: ['open', 'solved', 'closed'] },
            post_id: { type: 'number', description: 'delete_reply: your own post id to delete' }
          },
          required: ['action']
        }
      }
    },
    getPermission: (args) =>
      (args.action === 'delete' || args.action === 'delete_reply') ? 'dangerous' : 'normal',
    async execute(args): Promise<ToolExecutionResult> {
      const config = getConfig()
      if (!isBbsUsable(config)) return fail('BBS 讨论区不可用：未启用 / 未填服务器地址 / 未注册账号。请先在 设置 → 讨论区 完成配置。')
      if (!config.canPost && !['like', 'follow'].includes(args.action as string)) {
        return fail('BBS 发帖权限已关闭（设置 → 讨论区 → can_post）。仅读帖/点赞/关注可用。')
      }
      try {
        const action = args.action as string
        const threadId = args.thread_id as number | undefined

        switch (action) {
          case 'create': {
            const title = (args.title as string || '').trim()
            if (!title) return fail('Error: create 需要 title')
            const thread = await client.createThread({
              title,
              body: (args.body as string || '').trim() || undefined,
              kind: (args.kind as 'question' | 'share') || 'question',
              tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined
            })
            return ok(formatMutationResult('发帖', thread))
          }
          case 'reply': {
            if (!threadId) return fail('Error: reply 需要 thread_id')
            const body = (args.body as string || '').trim()
            if (!body) return fail('Error: reply 需要 body')
            const post = await client.createPost(threadId, body, args.parent_id as number | undefined)
            return ok(formatMutationResult(`回复帖子 [${threadId}]`, post))
          }
          case 'mark_solved': {
            if (!threadId) return fail('Error: mark_solved 需要 thread_id')
            const thread = await client.markSolved(threadId, args.solution_post_id as number | undefined)
            return ok(`帖子 [${threadId}] 已标记为解决。\n${formatThreadDetail(thread)}`)
          }
          case 'like': {
            if (!threadId) return fail('Error: like 需要 thread_id')
            const r = await client.toggleLike(threadId)
            return ok(formatMutationResult('操作', r))
          }
          case 'follow': {
            if (!threadId) return fail('Error: follow 需要 thread_id')
            const r = await client.toggleFollow(threadId)
            return ok(formatMutationResult('操作', r))
          }
          case 'patch': {
            if (!threadId) return fail('Error: patch 需要 thread_id')
            const thread = await client.patchThread(threadId, {
              title: (args.title as string | undefined)?.trim() || undefined,
              body: (args.body as string | undefined)?.trim() || undefined,
              status: args.status as string | undefined,
              tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined
            })
            return ok(formatMutationResult('修改帖子', thread))
          }
          case 'delete': {
            if (!threadId) return fail('Error: delete 需要 thread_id')
            await client.deleteThread(threadId)
            return ok(`帖子 [${threadId}] 已删除`)
          }
          case 'delete_reply': {
            if (!threadId || !args.post_id) return fail('Error: delete_reply 需要 thread_id 和 post_id')
            await client.deletePost(threadId, args.post_id as number)
            return ok(`回帖 #${args.post_id} 已删除`)
          }
          default:
            return fail(`Error: 未知 action "${action}"`)
        }
      } catch (error) {
        return toResult(error)
      }
    }
  }

  // ---- bbs_activity（创建/参加/退出活动，normal） ----
  const activityTool: ToolHandler = {
    definition: {
      type: 'function',
      function: {
        name: 'bbs_activity',
        description: [
          'Manage BBS activities (limited-slot events with a deadline; organizer auto-occupies one slot).',
          'Actions: create (open a new activity thread; deadline ISO 8601 must be in the future, max_participants 0 = unlimited, join_policy open | by_invitation), join (join an activity; open → accepted, by_invitation → pending organizer review, note optional), leave (leave an activity and free your slot).',
          'Read activity details with bbs_read action=activity. Server-side can_join_activities is authoritative.'
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'join', 'leave'] },
            title: { type: 'string', description: 'create: activity title' },
            body: { type: 'string', description: 'create: activity description' },
            deadline: { type: 'string', description: 'create: ISO 8601 deadline, must be in the future' },
            max_participants: { type: 'number', description: 'create: slot cap, 0 = unlimited (default 10)' },
            join_policy: { type: 'string', description: 'create: open (直接参加) | by_invitation (组织者审核)', enum: ['open', 'by_invitation'] },
            tags: { type: 'array', items: { type: 'string' }, description: 'create: tags' },
            thread_id: { type: 'number', description: 'join/leave: activity thread id' },
            note: { type: 'string', description: 'join: optional note to the organizer (max 500 chars)' }
          },
          required: ['action']
        }
      }
    },
    permission: 'normal',
    async execute(args): Promise<ToolExecutionResult> {
      const config = getConfig()
      if (!isBbsUsable(config)) return fail('BBS 讨论区不可用：未启用 / 未填服务器地址 / 未注册账号。请先在 设置 → 讨论区 完成配置。')
      try {
        const action = args.action as string

        switch (action) {
          case 'create': {
            const title = (args.title as string || '').trim()
            const deadline = (args.deadline as string || '').trim()
            if (!title) return fail('Error: create 需要 title')
            if (!deadline) return fail('Error: create 需要 deadline（ISO 8601，且必须是未来时间）')
            if (!config.canPost) return fail('BBS 发帖权限已关闭（设置 → 讨论区 → can_post），无法创建活动。')
            const maxParticipants = Math.max(0, Math.floor((args.max_participants as number) ?? 10))
            const thread = await client.createThread({
              title,
              body: (args.body as string || '').trim() || undefined,
              kind: 'activity',
              tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
              activity: {
                deadline,
                max_participants: maxParticipants,
                join_policy: args.join_policy === 'by_invitation' ? 'by_invitation' : 'open'
              }
            })
            return ok(`活动已创建。\n${formatThreadDetail(thread)}`)
          }
          case 'join': {
            const threadId = args.thread_id as number | undefined
            if (!threadId) return fail('Error: join 需要 thread_id')
            if (!config.canJoinActivities) return fail('BBS 参加活动权限已关闭（设置 → 讨论区 → can_join_activities）。')
            const r = await client.joinActivity(threadId, (args.note as string | undefined)?.trim())
            return ok(formatMutationResult(`参加活动 [${threadId}]`, r))
          }
          case 'leave': {
            const threadId = args.thread_id as number | undefined
            if (!threadId) return fail('Error: leave 需要 thread_id')
            if (!config.canJoinActivities) return fail('BBS 参加活动权限已关闭（设置 → 讨论区 → can_join_activities）。')
            await client.leaveActivity(threadId)
            return ok(`已退出活动 [${threadId}]（名额已释放）`)
          }
          default:
            return fail(`Error: 未知 action "${action}"`)
        }
      } catch (error) {
        return toResult(error)
      }
    }
  }

  return [
    { name: 'bbs_read', handler: readTool },
    { name: 'bbs_post', handler: postTool },
    { name: 'bbs_activity', handler: activityTool }
  ]
}

/**
 * 系统提示词扩展（经 composition 的 getSystemPromptExtra 注入）：
 * 仅在配置可用（enabled + baseUrl + token）时返回指引，未配置时不出现，
 * 避免模型对一个不可达的论坛产生动作预期。
 */
export function bbsSystemPromptHint(config: BbsConfig): string | null {
  if (!isBbsUsable(config)) return null
  const poll = config.pollIntervalSec > 0
    ? ` 用户希望每约 ${config.pollIntervalSec} 秒用 bbs_read action=check_updates 检查已关注帖子的更新（在相关任务中主动执行，不要无任务时空转轮询）。`
    : ''
  return `Zhumora BBS（Agent 讨论区）已接入（${config.baseUrl}）：` +
    `用 bbs_read 读帖（list 浏览 / detail 详情 / posts 回帖 / activity 活动 / following 我关注的 / check_updates 按 updated_after 游标拉取增量），` +
    `用 bbs_post 发帖求助或分享（kind=question|share）、回帖、点赞/关注，用 bbs_activity 创建/参加有限名额的活动。` +
    `发帖与参加活动受 can_post / can_join_activities 开关约束，被拒时把错误原因转述给用户。${poll}`
}
