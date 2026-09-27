import assert from 'node:assert/strict'
import {
  DEFAULT_BBS_CONFIG,
  equivalentBbsConfig,
  isBbsUsable,
  normalizeBbsConfig
} from '../src/shared/bbs.ts'
import {
  createBbsClient,
  extractBbsErrorDetail,
  BbsError,
  type BbsClientLike
} from '../src/main/bbs/client.ts'
import {
  formatActivity,
  formatMutationResult,
  formatPostsList,
  formatThreadDetail,
  formatThreadList
} from '../src/main/bbs/format.ts'
import { bbsSystemPromptHint, createBbsTools } from '../src/main/bbs/tools.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'

// ============================================================
// 1. 配置归一化（边界归一：旧/脏数据只在这里收口）
// ============================================================
assert.deepEqual(normalizeBbsConfig(undefined), DEFAULT_BBS_CONFIG)
assert.deepEqual(normalizeBbsConfig(null), DEFAULT_BBS_CONFIG)
assert.deepEqual(normalizeBbsConfig({}), DEFAULT_BBS_CONFIG)
// enabled 严格布尔判定（脏数据 1 归一为 false，避免"看起来开着"）
assert.deepEqual(normalizeBbsConfig({ enabled: 1, baseUrl: '127.0.0.1:8000', token: ' tok ' }), {
  ...DEFAULT_BBS_CONFIG,
  baseUrl: 'http://127.0.0.1:8000',
  token: 'tok'
})
assert.deepEqual(normalizeBbsConfig({ enabled: true, baseUrl: '127.0.0.1:8000', token: ' tok ' }), {
  ...DEFAULT_BBS_CONFIG,
  enabled: true,
  baseUrl: 'http://127.0.0.1:8000',
  token: 'tok'
})
assert.equal(normalizeBbsConfig({ baseUrl: 'http://host:8000///' }).baseUrl, 'http://host:8000')
assert.equal(normalizeBbsConfig({ baseUrl: 'https://host:8000/a/b' }).baseUrl, 'https://host:8000/a/b')
assert.equal(normalizeBbsConfig({ pollIntervalSec: '5' as unknown as number }).pollIntervalSec, 0)
assert.equal(normalizeBbsConfig({ pollIntervalSec: -3 }).pollIntervalSec, 0)
assert.equal(normalizeBbsConfig({ pollIntervalSec: 999999 }).pollIntervalSec, 3600)
assert.equal(normalizeBbsConfig({ pollIntervalSec: 30.4 }).pollIntervalSec, 30)
assert.deepEqual(normalizeBbsConfig({ canPost: false, canJoinActivities: false }), {
  ...DEFAULT_BBS_CONFIG,
  canPost: false,
  canJoinActivities: false
})
// 语义比较：字段顺序无关
assert.equal(equivalentBbsConfig(
  { enabled: true, baseUrl: 'http://h:1', token: 't', canPost: true, canJoinActivities: true, pollIntervalSec: 10 },
  { pollIntervalSec: 10, canJoinActivities: true, canPost: true, token: 't', baseUrl: 'http://h:1', enabled: true }
), true)
assert.equal(equivalentBbsConfig(DEFAULT_BBS_CONFIG, { ...DEFAULT_BBS_CONFIG, pollIntervalSec: 1 }), false)
// 可用性
assert.equal(isBbsUsable(DEFAULT_BBS_CONFIG), false)
assert.equal(isBbsUsable({ ...DEFAULT_BBS_CONFIG, enabled: true, baseUrl: 'http://h', token: '' }), false)
assert.equal(isBbsUsable({ ...DEFAULT_BBS_CONFIG, enabled: true, baseUrl: 'http://h', token: 't' }), true)

// ============================================================
// 2. 客户端：错误提取与 URL 拼装
// ============================================================
assert.equal(extractBbsErrorDetail({ detail: 'Invalid credentials.' }), 'Invalid credentials.')
assert.equal(extractBbsErrorDetail({ username: ['An account with this username already exists.'] }), 'An account with this username already exists.')
assert.equal(extractBbsErrorDetail('plain text error'), 'plain text error')
assert.equal(extractBbsErrorDetail(null), '')
assert.equal(extractBbsErrorDetail({ foo: 123 }), JSON.stringify({ foo: 123 }))

// ============================================================
// 3. 客户端：mock fetch 的行为矩阵
// ============================================================
function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const decision = handler(String(url), init)
    const body = decision.body ?? {}
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: decision.status ?? 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as unknown as typeof fetch
}

const goodConfig = { enabled: true, baseUrl: 'http://bbs:8000', token: 'tok', canPost: true, canJoinActivities: true, pollIntervalSec: 0 }

const makeClient = (config: BbsConfig, fetchFn: typeof fetch) =>
  createBbsClient({ getConfig: () => config, getFetch: () => fetchFn })

async function test_() {
  // 列表：携带 Bearer，query 归一
  let seen: { url: string; init?: RequestInit } | null = null
  const listClient = makeClient(goodConfig, mockFetch((url, init) => {
    seen = { url, init }
    return { body: { count: 1, next: null, previous: null, results: [{ id: 7, title: 'T', kind: 'question', status: 'open', author: { username: 'a', is_agent: true } }] } }
  })) as BbsClientLike
  const list = await listClient.listThreads({ q: 'help me', limit: 20, followingMe: true })
  assert.equal(list.count, 1)
  assert.equal(list.results[0].id, 7)
  assert.ok(seen!.url.includes('/api/threads/?'))
  assert.ok(seen!.url.includes('q=help+me'))
  assert.ok(seen!.url.includes('following=me'))
  assert.ok(seen!.url.includes('limit=20'))
  assert.equal(seen!.init?.headers && (seen!.init!.headers as Record<string, string>)['Authorization'], 'Bearer tok')

  // 注册成功：token 只返回这一次
  const regClient = makeClient({ ...goodConfig, token: '' }, mockFetch((url) => {
    assert.ok(url.endsWith('/api/agent/register/'))
    return { status: 201, body: { id: 1, username: 'bot1', agent_token: 'NEW_TOKEN', display_name: 'Bot One', can_post: true, can_join_activities: true, is_active: true } }
  })) as BbsClientLike
  const reg = await regClient.register('bot1', 'password123', 'Bot One')
  assert.equal(reg.created, true)
  assert.equal(reg.token, 'NEW_TOKEN')
  assert.equal(reg.profile?.username, 'bot1')

  // 注册 409 → created=false（token 永不回显，只能 login）
  const conflictClient = makeClient({ ...goodConfig, token: '' }, mockFetch(() => ({
    status: 409,
    body: { username: ['An account with this username already exists.'] }
  }))) as BbsClientLike
  const conflict = await conflictClient.register('bot1', 'password123')
  assert.equal(conflict.created, false)
  assert.equal(conflict.token, null)
  assert.match(conflict.error || '', /already exists/)

  // 未启用 → BbsError(config)
  const disabledClient = makeClient({ ...DEFAULT_BBS_CONFIG }, mockFetch(() => ({ body: {} }))) as BbsClientLike
  await assert.rejects(() => disabledClient.listThreads({}), (e: unknown) => e instanceof BbsError && e.code === 'config')
  // 未注册 → BbsError(config)
  const noTokenClient = makeClient({ ...DEFAULT_BBS_CONFIG, enabled: true, baseUrl: 'http://h' }, mockFetch(() => ({ body: {} }))) as BbsClientLike
  await assert.rejects(() => noTokenClient.me(), (e: unknown) => e instanceof BbsError && e.code === 'config')

  // 网络错误 → BbsError(network)
  const netDown = makeClient(goodConfig, (async () => { throw new Error('fetch failed') }) as typeof fetch) as BbsClientLike
  await assert.rejects(() => netDown.listThreads({}), (e: unknown) => e instanceof BbsError && e.code === 'network')

  // HTTP 403 → BbsError(http, status=403)，detail 提取
  const forbidden = makeClient(goodConfig, mockFetch(() => ({ status: 403, body: { detail: 'This agent is not allowed to post.' } }))) as BbsClientLike
  await assert.rejects(() => forbidden.createPost(1, 'hi'), (e: unknown) =>
    e instanceof BbsError && e.code === 'http' && e.status === 403 && /not allowed to post/.test(e.message))

  // health 失败不抛
  const healthDown = makeClient({ ...goodConfig }, (async () => { throw new Error('down') }) as typeof fetch) as BbsClientLike
  assert.equal(await healthDown.health(), false)
}

// ============================================================
// 4. 工具层：权限矩阵与 isError 语义
// ============================================================
function makeTools(config = goodConfig) {
  const noop = () => { throw new Error('should not be called') }
  const fakeClient = {
    health: noop, register: noop, login: noop, me: noop, patchProfile: noop,
    listThreads: async () => ({ count: 0, next: null, previous: null, results: [] }),
    getThread: async () => ({ id: 1, title: 't', kind: 'question', status: 'open', author: { username: 'me' } }),
    createThread: async () => ({ id: 2, title: 'new', kind: 'question', status: 'open', author: { username: 'me' } }),
    patchThread: async () => ({}), deleteThread: async () => undefined,
    toggleLike: async () => ({ liked: true, like_count: 3 }),
    toggleFollow: async () => ({ following: true }),
    listFollowing: async () => [],
    markSolved: async () => ({}),
    listPosts: async () => [],
    createPost: async () => ({ id: 9, body: 'x', author: { username: 'me' } }),
    deletePost: async () => undefined,
    getActivity: async () => ({}),
    joinActivity: async () => ({ status: 'accepted' }),
    leaveActivity: async () => undefined
  }
  const registry = new ToolRegistry()
  for (const { name, handler } of createBbsTools({ client: fakeClient, getConfig: () => config })) {
    registry.register(name, handler, 'builtin')
  }
  return { registry, fakeClient }
}

const { registry: toolRegistry2 } = makeTools()
assert.ok(toolRegistry2.get('bbs_read'))
assert.ok(toolRegistry2.get('bbs_post'))
assert.ok(toolRegistry2.get('bbs_activity'))
assert.equal(toolRegistry2.permission('bbs_read', { action: 'list' }), 'safe')
assert.equal(toolRegistry2.permission('bbs_post', { action: 'create' }), 'normal')
assert.equal(toolRegistry2.permission('bbs_post', { action: 'delete' }), 'dangerous')
assert.equal(toolRegistry2.permission('bbs_post', { action: 'delete_reply' }), 'dangerous')
assert.equal(toolRegistry2.permission('bbs_post', { action: 'like' }), 'normal')
assert.equal(toolRegistry2.permission('bbs_activity', { action: 'join' }), 'normal')

async function main() {
  // disabled → isError 且不打网络
  const disabled = makeTools({ ...DEFAULT_BBS_CONFIG, baseUrl: 'http://h', token: 't' })
  const readRes = await disabled.registry.get('bbs_read')!.handler.execute({ action: 'list' }, { workspacePath: '' })
  assert.equal(readRes.isError, true)
  assert.match(String((readRes as { content: string }).content), /未启用/)
  const postRes = await disabled.registry.get('bbs_post')!.handler.execute({ action: 'create', title: 'x' }, { workspacePath: '' })
  assert.equal(postRes.isError, true)

  // canPost 关闭：create 被本地拦截；like 放行
  const noPost = makeTools({ ...goodConfig, canPost: false })
  const blocked = await noPost.registry.get('bbs_post')!.handler.execute({ action: 'create', title: 'x' }, { workspacePath: '' })
  assert.equal(blocked.isError, true)
  assert.match(String((blocked as { content: string }).content), /can_post/)
  const liked = await noPost.registry.get('bbs_post')!.handler.execute({ action: 'like', thread_id: 1 }, { workspacePath: '' })
  assert.equal(liked.isError, undefined)
  assert.match(String((liked as { content: string }).content), /点赞/)

  // canJoinActivities 关闭：join 被拦截
  const noAct = makeTools({ ...goodConfig, canJoinActivities: false })
  const noJoin = await noAct.registry.get('bbs_activity')!.handler.execute({ action: 'join', thread_id: 1 }, { workspacePath: '' })
  assert.equal(noJoin.isError, true)
  assert.match(String((noJoin as { content: string }).content), /can_join_activities/)

  // 403 透传（服务端为权威）
  const serverForbidden = makeTools(goodConfig)
  const forbiddenClient = makeClient(goodConfig, mockFetch(() => ({ status: 403, body: { detail: 'This agent is not allowed to post.' } }))) as BbsClientLike
  ;(serverForbidden.fakeClient as unknown as { createThread: () => Promise<unknown> }).createThread = () => forbiddenClient.createThread({ title: 'x', kind: 'question' })
  const serverDenied = await serverForbidden.registry.get('bbs_post')!.handler.execute({ action: 'create', title: 'x' }, { workspacePath: '' })
  assert.equal(serverDenied.isError, true)
  assert.match(String((serverDenied as { content: string }).content), /not allowed to post/)

  // 正常读帖
  const okTools = makeTools(goodConfig)
  const listOk = await okTools.registry.get('bbs_read')!.handler.execute({ action: 'list' }, { workspacePath: '' })
  assert.equal(listOk.isError, undefined)
  assert.match(String((listOk as { content: string }).content), /没有帖子/)

  // detail 缺 id
  const noId = await okTools.registry.get('bbs_read')!.handler.execute({ action: 'detail' }, { workspacePath: '' })
  assert.equal(noId.isError, true)

  // 测试客户端行为矩阵
  await test_()
}

// ============================================================
// 5. 格式化：分页 / 截断 / 活动
// ============================================================
const paged = formatThreadList({ count: 41, next: 'x', previous: null, results: [{ id: 1, title: 'First', kind: 'question', status: 'open', author: { username: 'a' }, like_count: 2, reply_count: 3 }] })
assert.match(paged, /共 41 条，本页 1 条/)
assert.match(paged, /\[1\] \| First/)
assert.match(paged, /还有 40 条/)
const bare = formatThreadList([{ id: 5, title: 'Bare', kind: 'share', status: 'open', author: { username: 'b' } }])
assert.match(bare, /共 1 条/)
assert.equal(formatThreadList({ results: [] }), '（没有帖子）')
const detail = formatThreadDetail({ id: 2, title: 'Q', kind: 'question', status: 'solved', author: { username: 'me' }, body: 'line1\nline2' })
assert.match(detail, /✔ solved/)
assert.match(detail, /line1\n    line2/)
const longBody = formatThreadDetail({ id: 3, title: 'L', kind: 'share', status: 'open', author: { username: 'x' }, body: 'A'.repeat(20000) })
assert.match(longBody, /已截断/)
const posts = formatPostsList([{ id: 10, body: 'ans', author: { username: 'p1' }, parent: null }, { id: 11, body: 'root', author: { username: 'p0' }, parent: 0 }])
assert.match(posts, /2 条回帖/)
assert.equal(formatPostsList([]), '（该帖暂无回帖）')
const act = formatActivity({ max_participants: 3, accepted_count: 1, remaining_slots: 2, join_policy: 'open', is_closed: false, deadline: '2026-10-01T00:00:00Z', participants: [{ agent: { username: 'me' }, status: 'accepted' }] })
assert.match(act, /1\/3 已接受/)
assert.match(act, /开放报名/)
assert.match(act, /@me \[accepted\]/)
assert.match(formatActivity({ max_participants: 0, accepted_count: 4, join_policy: 'by_invitation', is_closed: true }), /不限名额/)
assert.match(formatActivity({ max_participants: 0, join_policy: 'open', participants: [] }), /（空）/)
assert.match(formatMutationResult('操作', { liked: true, like_count: 5 }), /点赞已开启/)
assert.match(formatMutationResult('操作', { liked: false, like_count: 4 }), /取消/)
assert.match(formatMutationResult('操作', { following: false }), /关注已取消/)

// 系统提示词扩展：未配置 → 不注入；可用 → 注入；轮询开启 → 带轮询指引
assert.equal(bbsSystemPromptHint(DEFAULT_BBS_CONFIG), null)
assert.equal(bbsSystemPromptHint({ ...DEFAULT_BBS_CONFIG, enabled: true, baseUrl: 'http://h' }), null)
const hint = bbsSystemPromptHint(goodConfig)
assert.ok(hint)
assert.match(hint!, /http:\/\/bbs:8000/)
assert.match(hint!, /bbs_read/)
assert.match(hint!, /bbs_post/)
assert.match(hint!, /bbs_activity/)
assert.equal(bbsSystemPromptHint({ ...goodConfig, pollIntervalSec: 30 })!.includes('每约 30 秒'), true)
assert.equal(hint!.includes('每约'), false)

main().then(() => {
  console.log('bbs tests passed')
}).catch(error => {
  console.error(error)
  process.exit(1)
})
