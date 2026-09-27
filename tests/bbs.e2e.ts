// 真实后端 E2E（需本地 Django 运行在 BASE 指向的地址）。手动运行：
//   node --no-warnings tests/bbs.e2e.ts [baseUrl]
import assert from 'node:assert/strict'
import { createBbsClient, BbsError } from '../src/main/bbs/client.ts'
import { createBbsTools } from '../src/main/bbs/tools.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { normalizeBbsConfig, DEFAULT_BBS_CONFIG } from '../src/shared/bbs.ts'
import { formatThreadList, formatPostsList, formatActivity } from '../src/main/bbs/format.ts'

const BASE = process.argv[2] || 'http://127.0.0.1:8123'
const stamp = Date.now().toString(36)
const state = { current: normalizeBbsConfig({ ...DEFAULT_BBS_CONFIG, baseUrl: BASE, enabled: true }) }
const client = createBbsClient({ getConfig: () => state.current, getFetch: () => fetch })

// 1. health
assert.equal(await client.health(), true)

// 2. 注册（token 只返回一次）
const reg = await client.register(`e2e-agent-${stamp}`, `pass-${stamp}-123`, `E2E ${stamp}`)
assert.equal(reg.created, true, reg.error)
assert.ok(reg.token)
state.current = { ...state.current, token: reg.token!, canPost: reg.profile!.can_post, canJoinActivities: reg.profile!.can_join_activities }
console.log(`✓ register → token ${reg.token!.slice(0, 6)}…`)

// 3. 重复注册 → 409 不抛
const conflict = await client.register(`e2e-agent-${stamp}`, 'whatever-123')
assert.equal(conflict.created, false)
console.log('✓ duplicate register → 409 handled')

// 4. login 换回 token
const login = await client.login(`e2e-agent-${stamp}`, `pass-${stamp}-123`)
assert.equal(login.token, reg.token)
console.log('✓ login → same stable token')

// 5. 工具层全流程
const registry = new ToolRegistry()
for (const { name, handler } of createBbsTools({ client, getConfig: () => state.current })) {
  registry.register(name, handler, 'builtin')
}
const read = async (action: string, extra: Record<string, unknown> = {}) =>
  (await registry.get('bbs_read')!.handler.execute({ action, ...extra } as any, { workspacePath: '' })) as { content: string; isError?: boolean }
const post = async (args: Record<string, unknown>) =>
  (await registry.get('bbs_post')!.handler.execute(args as any, { workspacePath: '' })) as { content: string; isError?: boolean }
const act = async (args: Record<string, unknown>) =>
  (await registry.get('bbs_activity')!.handler.execute(args as any, { workspacePath: '' })) as { content: string; isError?: boolean }

// 发帖求助
const created = await post({ action: 'create', title: `E2E 求助帖 ${stamp}`, body: '谁来帮我看看？', kind: 'question', tags: ['e2e', 'test'] })
assert.equal(created.isError, undefined, created.content)
assert.match(created.content, /发帖 成功：\[\d+\]/)
const threadId = Number(/\[(\d+)\]/.exec(created.content)![1])
console.log(`✓ create question thread #${threadId}`)

// 回帖
const reply = await post({ action: 'reply', thread_id: threadId, body: '试试这个方法：重启' })
assert.equal(reply.isError, undefined, reply.content)
assert.match(reply.content, /回复帖子 \[\d+\] 成功（id=\d+）/)
console.log('✓ reply')

// 读回帖
const posts = await read('posts', { thread_id: threadId })
assert.equal(posts.isError, undefined, posts.content)
assert.match(posts.content, /1 条回帖/)
assert.match(posts.content, /重启/)
console.log('✓ read posts')

// 关注 + 轮询更新（先制造一次更新：再回一条）
await post({ action: 'reply', thread_id: threadId, body: '更新了' })
const updates = await read('check_updates', { updated_after: new Date(Date.now() - 60000).toISOString() })
assert.equal(updates.isError, undefined, updates.content)
assert.match(updates.content, /E2E 求助帖/)
console.log('✓ check_updates sees own activity')

// 活动：创建（开放报名，2 名额）
const deadline = new Date(Date.now() + 3600_000).toISOString()
const actCreated = await act({ action: 'create', title: `E2E 活动 ${stamp}`, body: '限量测试', deadline, max_participants: 2 })
assert.equal(actCreated.isError, undefined, actCreated.content)
const actThreadId = Number(/\[(\d+)\]/.exec(actCreated.content)![1])
console.log(`✓ create activity #${actThreadId}`)

// 活动详情：组织者自动占 1 名额
const actDetail = await read('activity', { thread_id: actThreadId })
assert.equal(actDetail.isError, undefined, actDetail.content)
assert.match(actDetail.content, /1\/2 已接受/)
console.log('✓ activity detail shows organizer slot')

// 第二个 agent 注册并参加 → 满员
const reg2 = await client.register(`e2e-agent2-${stamp}`, `pass-${stamp}-456`)
assert.equal(reg2.created, true, reg2.error)
state.current = { ...state.current, token: reg2.token! }
const joined = await act({ action: 'join', thread_id: actThreadId, note: '我来' })
assert.equal(joined.isError, undefined, joined.content)
// 第三个 agent → 409/403（名额满）
const reg3 = await client.register(`e2e-agent3-${stamp}`, `pass-${stamp}-789`)
state.current = { ...state.current, token: reg3.token! }
const full = await act({ action: 'join', thread_id: actThreadId })
assert.equal(full.isError, true)
assert.match(full.content, /403|409|closed|full/)
console.log('✓ join full activity → error surfaced')

// 恢复第一个 agent 权限开关：关闭 can_post → 本地拦截
state.current = { ...state.current, token: reg.token!, canPost: false }
const blocked = await post({ action: 'create', title: 'x' })
assert.equal(blocked.isError, true)
assert.match(blocked.content, /can_post/)
console.log('✓ can_post off → local block')

// 服务端权威：把 can_post 关到后端，本地仍开 → 403 透传
state.current = { ...state.current, canPost: true }
await client.patchProfile({ can_post: false })
const serverDenied = await post({ action: 'reply', thread_id: threadId, body: '应被 403' })
assert.equal(serverDenied.isError, true)
assert.match(serverDenied.content, /403/)
console.log('✓ server-side can_post=false → 403 passed through')
await client.patchProfile({ can_post: true })

// 格式化函数对真实数据
const realList = await client.listThreads({ tag: 'e2e', limit: 50 })
const realListText = formatThreadList(realList)
assert.match(realListText, /E2E 求助帖|E2E 活动/)
const realPosts = await client.listPosts(threadId)
assert.match(formatPostsList(realPosts), /1 条回帖|2 条回帖/)
console.log('✓ formatters render real payloads')

// BbsError 未启用路径
const off = createBbsTools({ client, getConfig: () => DEFAULT_BBS_CONFIG })
const offRead = (await off[0].handler.execute({ action: 'list' }, { workspacePath: '' })) as { isError?: boolean; content: string }
assert.equal(offRead.isError, true)
assert.match(offRead.content, /未启用/)
console.log('✓ disabled config → isError, no network')

console.log('\nBBS E2E 全部通过 ✅')
process.exit(0)
