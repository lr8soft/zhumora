// MCP 入站服务器（外部编排器 ↔ Zhumora）测试。
// 覆盖：会话映射唯一性、chat 状态机（完成/busy/abort/输入校验）、
// 权限委托门禁（ui 模式外部不可裁决、delegate 模式 normal 可裁决、
// dangerous 恒归人）、respond 路由与终态幂等。
// 结构约束（AGENTS.md）：不引入 Electron——service 只依赖 SessionService API
// 与 BotMessageQueue，与 Bot 适配器同一测试模式。
import assert from 'node:assert/strict'
import net, { type AddressInfo } from 'node:net'
import { AgentAbortedError, type AppSettings, type Session, type UIMessage } from '../src/shared/types.ts'
import { PermissionBroker } from '../src/main/agent/permissionBroker.ts'
import { SessionService, type SessionStore } from '../src/main/agent/sessionService.ts'
import type { AgentEventCallbacks, AgentRunOptions } from '../src/main/agent/runner.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { BotSessionAdapter } from '../src/main/bot/sessionAdapter.ts'
import { McpInboundService } from '../src/main/mcpServer/service.ts'
import { createMcpTransport } from '../src/main/mcpServer/transport.ts'
import { McpServerManager } from '../src/main/mcpServer/server.ts'
import {
  createMcpTaskSession,
  delegateAllowsExternal,
  isTerminalMcpTaskStatus
} from '../src/main/agent/taskProtocol.ts'
import { ensureMcpServerToken, generateMcpServerToken, SERVER_INSTRUCTIONS } from '../src/shared/mcpServer.ts'

// ---------- fakes（与 sessionService.test.ts 同一模式） ----------

const settings = {
  providers: [{
    id: 'provider', name: 'Provider', baseUrl: 'http://localhost', apiKey: '',
    defaultModel: 'model', enabled: true
  }],
  activeProviderId: 'provider', workspacePath: 'D:/workspace', memoryEnabled: false, maxRounds: 20,
  mcpServers: [], skills: [],
  telegramBot: { enabled: false, token: '', allowedUserIds: [], approveMode: 'manual' },
  qqBot: { enabled: false, appId: '', appSecret: '', allowedUserIds: [], approveMode: 'manual' },
  avatarModels: [], defaultAvatarModelId: null, avatarWindowSize: { width: 400, height: 600 },
  ttsModels: [], defaultTtsModelId: null
} as AppSettings

const sessions = new Map<string, Session>()
const messages = new Map<string, UIMessage[]>()
const store: SessionStore = {
  createSession: () => { throw new Error('not used') },
  getSessions: () => [...sessions.values()],
  getSettings: () => settings,
  getSession: id => sessions.get(id) || null,
  updateSessionTitle: (id, title) => { const s = sessions.get(id); if (s) s.title = title },
  updateSessionWorkspace: (id, workspacePath) => { const s = sessions.get(id); if (s) s.workspacePath = workspacePath },
  deleteSession: id => { sessions.delete(id); messages.delete(id) },
  getOrCreateBotSession: (channel, accountId, conversationId, title) => {
    const key = `${channel}:${accountId}:${conversationId}`
    let session = sessions.get(key)
    if (!session) {
      session = {
        id: key, title, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0,
        origin: channel === 'telegram' || channel === 'qq' || channel === 'mcp' ? channel : 'renderer',
        avatarEnabled: false, ttsEnabled: false
      }
      sessions.set(key, session)
      messages.set(key, [])
    }
    return session
  },
  getMessages: id => [...(messages.get(id) || [])],
  addMessage: message => {
    let list = messages.get(message.sessionId)
    if (!list) { list = []; messages.set(message.sessionId, list) }
    list.push(message)
  },
  getSessionCompaction: () => null,
  setSessionCompaction: () => {},
  tryUpdateSessionTitleIfDefault: () => false,
  addTokenUsage: () => {}
}

type PermissionBehavior = 'none' | 'normal' | 'dangerous'
let permissionBehavior: PermissionBehavior = 'none'
/** 上一次权限检查的结果；'none' 表示本次运行未发生权限检查 */
let lastPermissionResult: 'none' | 'allowed' | 'denied' = 'none'
const releases = new Map<string, () => void>()
let optionsSeen: AgentRunOptions | null = null
const executeAgent = async (options: AgentRunOptions, callbacks: AgentEventCallbacks) => {
  const sessionId = options.sessionId!
  optionsSeen = options
  lastPermissionResult = 'none'
  // 权限检查在前（可在 broker 里挂起），release 门在后（模拟 LLM 后续耗时）
  if (permissionBehavior !== 'none' && options.permissionCheck) {
    lastPermissionResult = (await options.permissionCheck(
      permissionBehavior === 'normal' ? 'normal_tool' : 'dangerous_tool',
      { x: 1 }
    )) ? 'allowed' : 'denied'
    permissionBehavior = 'none'
  }
  await new Promise<void>((resolve, reject) => {
    releases.set(sessionId, resolve)
    options.signal?.addEventListener('abort', () => reject(new AgentAbortedError()), { once: true })
  })
  releases.delete(sessionId)
  callbacks.onAssistantMessage?.(lastPermissionResult === 'none' ? `done:${sessionId}` : (lastPermissionResult === 'allowed' ? 'tool-done' : 'tool-denied'), [])
  callbacks.onComplete?.()
  return []
}

let nextId = 0
const permissions = new PermissionBroker()
// SessionService 与 McpInboundService 共用同一个工具注册表（与生产组合根一致）：
// permissionCheck 的 level 判定读取此注册表，入站服务的裁决门禁也查它。
const sharedRegistry = new ToolRegistry()
sharedRegistry.register('normal_tool', {
  definition: def('normal_tool'), execute: async () => 'ok', permission: 'normal'
}, 'builtin')
sharedRegistry.register('dangerous_tool', {
  definition: def('dangerous_tool'), execute: async () => 'ok', permission: 'dangerous'
}, 'builtin')
const service = new SessionService({
  store,
  tools: sharedRegistry,
  permissions,
  getSkillsPrompt: () => '',
  getMcpStatus: () => [],
  executeAgent,
  fetchContextWindow: async () => 32768,
  planAutoCompact: async () => ({
    beforeTokens: 0, afterTokens: 0, compressedCount: 0, keptCount: 0, keptOffset: 0, summary: null
  }),
  completeText: async () => '',
  generateMessageId: () => `m${++nextId}`,
  now: () => 100
})

function def(name: string) {
  return { type: 'function' as const, function: { name, description: name, parameters: {} } }
}

const mcpDefaults = {
  token: 't', clientLabel: 'Codex', port: 0
}
function makeInbound(mode: 'ui' | 'delegate'): McpInboundService {
  return new McpInboundService(
    new BotSessionAdapter({ sessions: service }),
    service,
    permissions,
    sharedRegistry,
    { enabled: true, permissionMode: mode, approveMode: 'manual', ...mcpDefaults }
  )
}

const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms))
/** 释放某个 session 的挂起并清理，使下一次运行能重新注册 */
const releaseSession = (sessionId: string) => {
  releases.get(sessionId)?.()
  releases.delete(sessionId)
}
/** 轮询等待 release 门注册后释放（权限裁决后 runner 才注册，存在时序竞态） */
const releaseWhenReady = async (sessionId: string, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (!releases.has(sessionId) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  releaseSession(sessionId)
}
/**
 * 轮询会话的终态。chat 的 wait 在 awaiting_permission 时按协议提前返回
 * （编排器收到即应处理权限），因此运行结束要靠 zhumora_status 语义轮询取回。
 */
const awaitTerminal = async (inbound: McpInboundService, key: string): Promise<ReturnType<McpInboundService['status']>> => {
  for (let i = 0; i < 400; i++) {
    const status = inbound.status(key)
    if (isTerminalMcpTaskStatus(status)) return status
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`task for ${key} did not settle within 4s`)
}

// ---------- token 稳定性（storage 边界规则） ----------
// token 永不随应用重启自动轮换：存储边界在首次启用时生成一次固定值并落库，
// 之后只有用户显式重生成才轮换。

{
  // 生成器：base64url（无 +/=），32 字符（24 字节），两次调用不同
  const a = generateMcpServerToken()
  const b = generateMcpServerToken()
  assert.match(a, /^[A-Za-z0-9_-]{32}$/, 'token is 24 bytes of base64url')
  assert.notEqual(a, b)

  const base = { enabled: true, token: '', clientLabel: 'T', permissionMode: 'ui', approveMode: 'manual', port: 0 }
  const fixed = ensureMcpServerToken(base)
  assert.notEqual(fixed.token, '', 'first enable fixes a non-empty token')
  assert.notEqual(fixed, base, 'a new settings object is returned for persistence')

  // 已有 token 永不自动轮换：同一引用返回（跨重启读到的都是库里那个值）
  assert.equal(ensureMcpServerToken(fixed), fixed, 'an existing token is never rotated (same reference)')
  // 用户清空 token 再保存 → 保存瞬间重新固定一个新值（而非留空等运行时随机）
  const regenerated = ensureMcpServerToken({ ...fixed, token: '' })
  assert.notEqual(regenerated.token, fixed.token, 'clearing + saving generates a fresh fixed token')

  // 禁用态永不生成（不产生无主密钥）
  const disabled = { ...base, enabled: false }
  assert.equal(ensureMcpServerToken(disabled), disabled, 'disabled settings return the same reference (never touched)')
  const disabledWithToken = { ...disabled, token: 'x' }
  assert.equal(ensureMcpServerToken(disabledWithToken), disabledWithToken, 'a disabled token is never rotated')
}

// ---------- 委托契约文本：initialize instructions 与工具描述各自锁死 ----------
// 多数 host 不会把 MCP initialize instructions 可靠注入模型上下文（opencode 无此
// 通道；Codex 仅新版支持且不消费 prompts），对它们真正被看见的文字是 tools/list 的
// name+description。所以委托意愿三要素（同机能力、典型任务示例、负范围声明）必须
// 同时出现在 instructions 和 zhumora_chat 描述里；两处措辞独立维护，断言各自
// 锁住（下方 tools/list 断言覆盖工具描述一侧）。

{
  for (const token of ['zhumora_chat', 'zhumora_wait', 'zhumora_respond', 'zhumora_status', 'decidable_by_you']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(token), `instructions mention ${token}`)
  }
  assert.match(SERVER_INSTRUCTIONS, /proactively/, 'instructions ask for proactive delegation')
  assert.match(SERVER_INSTRUCTIONS, /deliberately/, 'instructions state that the user enabled Zhumora on purpose')
  // 委托意愿增强的三根支柱：
  // 1) “同一台机器”让模型理解 Zhumora 操作的就是它的文件系统/应用（而非另一台机器）；
  // 2) 具体任务示例给模型归类锚点（抽象场景描述不足以触发主动委托）；
  // 3) 负范围声明（沙箱内任务自己做）消除边界不确定导致的默认保守。
  assert.match(SERVER_INSTRUCTIONS, /same machine/i, 'instructions state Zhumora runs on the same machine')
  assert.match(SERVER_INSTRUCTIONS, /Typical delegated tasks/, 'instructions give concrete task examples')
  assert.match(SERVER_INSTRUCTIONS, /Do not delegate/, 'instructions draw the negative scope (sandbox-staying work)')
}

// ---------- taskProtocol 纯函数 ----------

{
  const task = createMcpTaskSession()
  assert.deepEqual(task.status(), { status: 'running' })
  assert.equal(isTerminalMcpTaskStatus(task.status()), false)
  task.markPermission({ permissionId: 'p1', toolName: 'normal_tool', args: {}, level: 'normal' })
  assert.deepEqual(task.status(), {
    status: 'awaiting_permission',
    permission: { permissionId: 'p1', toolName: 'normal_tool', args: {}, level: 'normal' }
  })
  assert.equal(task.getPermission('p1')?.toolName, 'normal_tool')
  assert.equal(task.getPermission('missing'), null)
  task.clearPermission({ permissionId: 'p1' })
  assert.deepEqual(task.status(), { status: 'running' })
  const final = task.settle({ status: 'completed', reply: 'result' })
  assert.deepEqual(final, { status: 'completed', reply: 'result' })
  // 终态幂等：后续 settle 不覆盖
  assert.deepEqual(task.settle({ status: 'failed', error: 'late' }), { status: 'completed', reply: 'result' })

  // wait：终态立即返回；等待中 settle 唤醒
  const waiting = task.wait(1000)
  task.settle({ status: 'completed', reply: 'result' })
  assert.deepEqual(await waiting, { status: 'completed', reply: 'result' })

  const nonBlocking = createMcpTaskSession()
  assert.deepEqual(await nonBlocking.wait(0), { status: 'running' },
    'wait_ms=0 is a non-blocking status snapshot, not an unbounded waiter')

  const streamed = createMcpTaskSession('task-stream')
  const update = streamed.waitForUpdate(0, 1000)
  streamed.sink.toolCall?.('s', 'm', {
    id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' }
  })
  const updateSnapshot = await update
  assert.equal(updateSnapshot.taskId, 'task-stream')
  assert.equal(updateSnapshot.activities[0]?.type, 'tool_call', 'activity wakes an event-driven waiter')
  const cursor = updateSnapshot.cursor
  streamed.sink.reasoning?.('s', 'm', 'private thought')
  streamed.sink.token?.('s', 'm', 'visible output')
  const publicSnapshot = streamed.snapshot(cursor)
  assert.deepEqual(publicSnapshot.activities.map(event => event.type), ['assistant_output'],
    'reasoning is hidden from returned activity unless explicitly requested')
  assert.deepEqual(streamed.snapshot(cursor, { includeReasoning: true }).activities.map(event => event.type),
    ['reasoning', 'assistant_output'])
  streamed.settle({ status: 'completed', reply: 'done' })
  assert.equal(streamed.snapshot().activities.at(-1)?.type, 'completed', 'completion is an explicit activity callback')

  assert.equal(delegateAllowsExternal('normal', false), true)
  assert.equal(delegateAllowsExternal('dangerous', false), false, 'dangerous is never external-decidable')
  assert.equal(delegateAllowsExternal('normal', true), false, 'alwaysConfirm tools are never external-decidable')
  assert.equal(delegateAllowsExternal('safe', false), false, 'safe never reaches presenters (auto-allowed upstream)')
}

// ---------- 会话映射 ----------

{
  const inbound = makeInbound('ui')
  const first = inbound.resolveSessionId('conv-a')
  const second = inbound.resolveSessionId('conv-a')
  assert.equal(first, second, 'the same external conversation always maps to the same session')
  const other = inbound.resolveSessionId('conv-b')
  assert.notEqual(first, other, 'different conversations get different sessions')
  assert.ok(first.startsWith('mcp:inbound:conv-a'), 'external identity is stored under the session service boundary')
  assert.deepEqual(inbound.status('unknown'), { status: 'busy' }, 'idle conversation reports busy, not a fake running task')
  await inbound.stop()
}

{
  // chat 可立即转后台；zhumora_wait 对应的 service 原语保持一个调用直至终态，
  // 不需要编排器每 30 秒轮询 status。
  const inbound = makeInbound('ui')
  const initial = await inbound.chat('callback', 'background work', 0)
  assert.equal(initial.status, 'running')
  const snapshot = inbound.snapshot('callback')!
  assert.equal(snapshot.taskId, 'task-1')
  const callback = inbound.waitForTask('callback', snapshot.taskId, snapshot.cursor, 5000, 'terminal')
  await releaseWhenReady(inbound.resolveSessionId('callback'))
  const completed = await callback
  assert.equal(completed.status.status, 'completed')
  assert.equal(completed.activities.at(-1)?.type, 'completed')
  await inbound.stop()
}

// ---------- chat 状态机 ----------

{
  const inbound = makeInbound('ui')
  // 输入校验
  assert.deepEqual(await inbound.chat('c1', '   '), { status: 'failed', error: 'Message text is required.' })

  // 正常完成：complete 事件是最终回复的权威来源；消息进入统一持久化
  const sessionId = inbound.resolveSessionId('c1')
  const resultPromise = inbound.chat('c1', 'do the thing', 5000)
  await releaseWhenReady(sessionId)
  const result = await resultPromise
  assert.deepEqual(result, { status: 'completed', reply: `done:${sessionId}` })
  assert.ok(optionsSeen?.systemPromptExtra?.includes('external orchestrator'),
    'the agent is told the sender is an orchestrator, not a human')
  // complete 先于 runner 收尾（cleanupRun 在 executeAgent 返回后的 finally）；等收尾完成
  await tick(30)
  assert.equal(service.isRunning(sessionId), false)
  assert.ok(messages.get(sessionId)?.some(m => m.content === 'do the thing'),
    'the delegated message is persisted through the unified Session path')
  await inbound.stop()
}

{
  const inbound = makeInbound('ui')
  // busy：运行中再来一条 → 返回当前任务状态，不排队第二条
  const running = inbound.chat('c2', 'long task')
  const sessionId = inbound.resolveSessionId('c2')
  await tick()
  assert.ok(service.isRunning(sessionId))
  const second = await inbound.chat('c2', 'second message', 0)
  assert.equal(second.status, 'running', 'a new message while running returns the current task state')
  releaseSession(sessionId)
  const first = await running
  assert.equal(first.status, 'completed')
  assert.equal(messages.get(sessionId)?.filter(m => m.role === 'user' && m.content === 'second message').length, 0,
    'the second message was not enqueued while the first task is running')
  await inbound.stop()
}

{
  const inbound = makeInbound('ui')
  // abort 级联：stop() 中止在途任务 → aborted 终态（有界 settle）
  const running = inbound.chat('c3', 'will be aborted')
  await tick()
  const sessionId = inbound.resolveSessionId('c3')
  assert.ok(service.isRunning(sessionId))
  await inbound.stop()
  assert.deepEqual(await running, { status: 'aborted' })
  await tick(30)
  assert.equal(service.isRunning(sessionId), false)
}

// ---------- 权限委托门禁（真实 broker 挂起链路） ----------

{
  const inbound = makeInbound('ui')
  permissionBehavior = 'normal'
  const running = inbound.chat('p-ui', 'need permission')
  const sessionId = inbound.resolveSessionId('p-ui')
  await tick()
  const status = await inbound.chat('p-ui', 'poll', 0)
  assert.equal(status.status, 'awaiting_permission', 'ui mode: the client can see the pending permission state')
  const permissionId = (status as { permission: { permissionId: string } }).permission.permissionId
  assert.equal(status.permission?.level, 'normal')

  const externalDenial = inbound.respond('p-ui', permissionId, false, 'external should not decide')
  assert.equal(externalDenial.status, 'awaiting_permission',
    'ui mode: external denial is ignored just like external approval')
  const decision = inbound.respond('p-ui', permissionId, true, 'external should not win')
  assert.equal(decision.status, 'awaiting_permission',
    'ui mode: external approval is ignored and the request stays with the human UI')
  assert.equal(permissions.respond(permissionId, false), true, 'the human (UI) can still decide afterwards')
  await releaseWhenReady(sessionId)
  void running
  const settled = await awaitTerminal(inbound, 'p-ui')
  assert.equal(settled.status, 'completed')
  assert.equal(settled.reply, 'tool-denied', 'the run proceeded with the human denial')
  await tick(30)
  assert.equal(service.isRunning(sessionId), false)
  await inbound.stop()
}

{
  const inbound = makeInbound('delegate')
  permissionBehavior = 'normal'
  const running = inbound.chat('p-delegate', 'need permission')
  await tick()
  const status = inbound.status('p-delegate')
  assert.equal(status.status, 'awaiting_permission')
  const permissionId = (status as { permission: { permissionId: string } }).permission.permissionId

  const decision = inbound.respond('p-delegate', permissionId, true, 'user authorized installs')
  assert.equal(decision.status, 'running', 'the run resumes after the external approval (not yet complete)')
  await releaseWhenReady(inbound.resolveSessionId('p-delegate'))
  void running
  const settled = await awaitTerminal(inbound, 'p-delegate')
  assert.equal(settled.status, 'completed')
  assert.equal(settled.reply, 'tool-done', 'the external approval let the normal tool proceed')
  await inbound.stop()
}

{
  const inbound = makeInbound('delegate')
  permissionBehavior = 'dangerous'
  const running = inbound.chat('p-dangerous', 'dangerous op')
  await tick()
  const status = inbound.status('p-dangerous')
  assert.equal(status.status, 'awaiting_permission')
  const permissionId = (status as { permission: { permissionId: string } }).permission.permissionId
  assert.equal(status.permission?.level, 'dangerous')

  const externalDenial = inbound.respond('p-dangerous', permissionId, false, 'please deny')
  assert.equal(externalDenial.status, 'awaiting_permission',
    'delegate mode: dangerous denial also stays with the human')
  const decision = inbound.respond('p-dangerous', permissionId, true, 'please')
  assert.equal(decision.status, 'awaiting_permission',
    'delegate mode: dangerous tools always wait for the human, even when the client approves')
  assert.equal(permissions.respond(permissionId, false), true, 'the human decides the dangerous tool')
  await releaseWhenReady(inbound.resolveSessionId('p-dangerous'))
  void running
  const settled = await awaitTerminal(inbound, 'p-dangerous')
  assert.equal(settled.status, 'completed')
  assert.equal(settled.reply, 'tool-denied')
  await inbound.stop()
}

{
  // respond 边界：无任务 / 未知 permissionId 都不破坏状态
  const inbound = makeInbound('delegate')
  assert.equal(inbound.respond('no-task', 'perm-x', true).status, 'busy')
  await inbound.stop()
}

// ---------- transport：真实 HTTP（loopback + Bearer + 会话头） ----------

{
  const inbound = makeInbound('ui')
  const token = 'transport-test-token'
  const transport = createMcpTransport({
    service: inbound,
    getSettings: () => ({ enabled: true, token, clientLabel: 'T', permissionMode: 'ui', approveMode: 'manual', port: 0 }),
    port: () => 0
  })
  await transport.start()
  assert.equal(transport.status(), 'running')
  const port = transport.port()!
  const base = `http://127.0.0.1:${port}/mcp`

  const rpc = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${token}`,
        ...headers
      },
      body: JSON.stringify(body)
    })

  const rpcMessages = async (response: Response): Promise<Array<Record<string, unknown>>> => {
    const text = await response.text()
    if ((response.headers.get('content-type') || '').includes('application/json')) {
      return [JSON.parse(text) as Record<string, unknown>]
    }
    return text.split(/\r?\n/)
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
  }
  const rpcBody = async (response: Response): Promise<any> => {
    const messages = await rpcMessages(response)
    return [...messages].reverse().find(message => 'result' in message || 'error' in message)
  }

  // 鉴权
  const noAuth = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(noAuth.status, 401)
  // 标准 401 必须带 WWW-Authenticate: Bearer——客户端（Codex 等）据此把失败
  // 归因为凭据问题而不是连接问题；裸 token 与缺 token 走同一条拒绝路径。
  assert.ok((noAuth.headers.get('www-authenticate') || '').toLowerCase().startsWith('bearer'),
    '401 must carry WWW-Authenticate: Bearer')
  const badAuth = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong' })
  assert.equal(badAuth.status, 401)

  // initialize：响应必须回带 Mcp-Session-Id（客户端后续请求依赖它关联会话）
  const initResponse = await rpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-test', version: '1' } }
  })
  assert.equal(initResponse.status, 200)
  const sessionHeader = initResponse.headers.get('mcp-session-id')
  assert.ok(sessionHeader, 'initialize returns Mcp-Session-Id')
  const initBody = (await rpcBody(initResponse)) as { result: { protocolVersion: string; serverInfo: { name: string }; instructions: string } }
  assert.equal(initBody.result.protocolVersion, '2025-06-18', 'the SDK negotiates a supported protocol version')
  assert.equal(initBody.result.serverInfo.name, 'zhumora')
  assert.ok(initBody.result.instructions.includes('zhumora_chat'))
  const sessionHeaders = { 'Mcp-Session-Id': sessionHeader, 'MCP-Protocol-Version': '2025-06-18' }

  // 通知（无 id）→ 202 无 body
  const notify = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionHeaders)
  assert.equal(notify.status, 202)

  // tools/list
  const listResponse = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionHeaders)
  const listBody = (await rpcBody(listResponse)) as { result: { tools: { name: string; description?: string }[] } }
  assert.deepEqual(listBody.result.tools.map(t => t.name).sort(),
    ['zhumora_chat', 'zhumora_respond', 'zhumora_status', 'zhumora_wait'])

  // 只注入 tools/list 的 host（Codex、opencode）能看到的唯一文字就是这些描述：触发场景与
  // “不得把 running 当完成”的规则必须写在 zhumora_chat 描述里，否则模型不知道何时主动委托。
  const chatDescription = listBody.result.tools.find(tool => tool.name === 'zhumora_chat')?.description ?? ''
  assert.match(chatDescription, /proactively/, 'chat description asks for proactive delegation')
  assert.match(chatDescription, /GUI/, 'chat description names the real-machine triggers')
  assert.match(chatDescription, /zhumora_wait/, 'chat description states the mandatory completion callback')
  // 只注入 tools/list 的 host（Codex、opencode）看不见 instructions 和 prompt：
  // 典型任务示例与负范围声明也必须写在描述里，否则模型没有归类锚点、边界不确定时默认保守。
  assert.match(chatDescription, /Typical tasks/, 'chat description gives concrete task examples')
  assert.match(chatDescription, /Do not use it for/, 'chat description draws the negative scope')

  // prompt 是给支持 prompts 的 host 的显式 subagent 工作流；关键规则同时存在于
  // instructions 和 tool description，避免 host 不自动注入 prompt 时模型看不见。
  const promptsResponse = await rpc({ jsonrpc: '2.0', id: 21, method: 'prompts/list' }, sessionHeaders)
  const promptsBody = (await rpcBody(promptsResponse)) as { result: { prompts: { name: string; description?: string }[] } }
  assert.equal(promptsBody.result.prompts[0]?.name, 'delegate-to-zhumora')

  // tools/call zhumora_status（空闲 → busy）
  const statusResponse = await rpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'zhumora_status', arguments: {} }
  }, sessionHeaders)
  const statusBody = (await rpcBody(statusResponse)) as { result: { content: { text: string }[] } }
  assert.equal(JSON.parse(statusBody.result.content[0].text).status, 'busy')

  // 未知方法 → JSON-RPC -32601
  const unknown = await rpc({ jsonrpc: '2.0', id: 4, method: 'nope' }, sessionHeaders)
  const unknownBody = (await rpcBody(unknown)) as { error: { code: number } }
  assert.equal(unknownBody.error.code, -32601)

  // 完整委托链路：zhumora_chat 走 SessionService → complete 回传
  const firstSessionId = `mcp:inbound:${sessionHeader}`
  setTimeout(() => releaseSession(firstSessionId), 80)
  const chatResponse = await rpc({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: {
      name: 'zhumora_chat',
      arguments: { message: 'hello from transport', wait_ms: 5000 },
      _meta: { progressToken: 'progress-1' }
    }
  }, sessionHeaders)
  const chatMessages = await rpcMessages(chatResponse)
  assert.ok(chatMessages.some(message => message.method === 'notifications/progress'),
    'a request-scoped MCP progress notification is delivered before the final tool result')
  const chatBody = [...chatMessages].reverse().find(message => 'result' in message) as unknown as {
    result: { content: { text: string }[] }
  }
  const chatResult = JSON.parse(chatBody.result.content[0].text)
  assert.equal(chatResult.status, 'completed')
  assert.equal(chatResult.reply, `done:${firstSessionId}`, 'Mcp-Session-Id is the stable external conversation key')

  // 同一会话头再来一条 → 复用同一 Zhumora session（消息累计进同一历史）
  // 第二次运行开始后才注册 release，用轮询释放保证时序
  const secondPromise = rpc({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'zhumora_chat', arguments: { message: 'second message', wait_ms: 5000 } }
  }, sessionHeaders)
  for (let i = 0; i < 200 && !releases.has(firstSessionId); i++) await new Promise(r => setTimeout(r, 10))
  releaseSession(firstSessionId)
  const second = await secondPromise
  const secondResult = JSON.parse(((await rpcBody(second)) as { result: { content: { text: string }[] } }).result.content[0].text)
  assert.equal(secondResult.status, 'completed')
  const history = service.getMessages(firstSessionId)
  assert.equal(history.filter(m => m.role === 'user').length, 2, 'both delegated messages share one session history')

  // 同一个 clientInfo.name 建立第二个 MCP session：必须隔离，不能按客户端名称串会话。
  const secondInit = await rpc({
    jsonrpc: '2.0', id: 7, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-test', version: '1' } }
  })
  const secondSessionHeader = secondInit.headers.get('mcp-session-id')
  assert.ok(secondSessionHeader && secondSessionHeader !== sessionHeader,
    'each initialize gets an independent MCP session even for the same client name')
  const secondSessionHeaders = { 'Mcp-Session-Id': secondSessionHeader, 'MCP-Protocol-Version': '2025-06-18' }
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, secondSessionHeaders)

  // wait_ms=0 必须立即返回 running；两个 session 可以同时启动，不互相 busy。
  const nonBlockingCall = (headers: Record<string, string>, message: string, id: number) => Promise.race([
    rpc({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'zhumora_chat', arguments: { message, wait_ms: 0 } }
    }, headers),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('wait_ms=0 did not return')), 500))
  ])
  const [firstRunningResponse, secondRunningResponse] = await Promise.all([
    nonBlockingCall(sessionHeaders, 'parallel one', 8),
    nonBlockingCall(secondSessionHeaders, 'parallel two', 9)
  ])
  const firstRunning = JSON.parse(((await rpcBody(firstRunningResponse)) as { result: { content: { text: string }[] } }).result.content[0].text)
  const secondRunning = JSON.parse(((await rpcBody(secondRunningResponse)) as { result: { content: { text: string }[] } }).result.content[0].text)
  assert.equal(firstRunning.status, 'running')
  assert.equal(secondRunning.status, 'running')
  const secondSessionId = `mcp:inbound:${secondSessionHeader}`
  const callbackResponsePromise = rpc({
    jsonrpc: '2.0', id: 22, method: 'tools/call',
    params: {
      name: 'zhumora_wait',
      arguments: {
        task_id: firstRunning.task_id,
        after_cursor: firstRunning.cursor,
        wait_ms: 5000,
        return_on: 'terminal'
      },
      _meta: { progressToken: 'callback-progress' }
    }
  }, sessionHeaders)
  await tick(30) // 让 wait handler 先订阅活动，再释放 runner
  await releaseWhenReady(firstSessionId)
  const callbackMessages = await rpcMessages(await callbackResponsePromise)
  assert.ok(callbackMessages.some(message => message.method === 'notifications/progress'),
    'zhumora_wait streams activity while one callback request remains pending')
  const callbackBody = [...callbackMessages].reverse().find(message => 'result' in message) as any
  const callbackResult = JSON.parse(callbackBody.result.content[0].text)
  assert.equal(callbackResult.status, 'completed', 'zhumora_wait delivers the terminal callback without status polling')
  await releaseWhenReady(secondSessionId)
  assert.equal((await awaitTerminal(inbound, sessionHeader)).status, 'completed')
  assert.equal((await awaitTerminal(inbound, secondSessionHeader)).status, 'completed')

  // 非 initialize 请求必须携带一个仍然有效的 session id。
  assert.equal((await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/list' })).status, 400)
  assert.equal((await rpc(
    { jsonrpc: '2.0', id: 11, method: 'tools/list' },
    { 'Mcp-Session-Id': 'unknown', 'MCP-Protocol-Version': '2025-06-18' }
  )).status, 404)

  // DELETE 终止 session 后，旧 session id 立即失效并从路由表清理。
  const deleted = await fetch(base, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, ...secondSessionHeaders }
  })
  assert.equal(deleted.status, 200)
  assert.equal((await rpc({ jsonrpc: '2.0', id: 12, method: 'tools/list' }, secondSessionHeaders)).status, 404)

  await transport.stop()
  assert.equal(transport.status(), 'stopped')
  assert.equal(transport.port(), null)
  await inbound.stop()
}

// 回归：客户端持有 GET SSE 长连接时 stop() 必须返回（曾经死锁）。
// streamable-http 客户端 initialize 后会一直开着 GET SSE 流，那是 active
// socket；stop 先关协议会话（级联结束 SSE 流）再关 HTTP server，顺序反了
// httpServer.close() 就永远等不到。token/端口变更重启依赖 stop 有界。
{
  const inbound = makeInbound('ui')
  const transport = createMcpTransport({
    service: inbound,
    getSettings: () => ({ enabled: true, token: 'sse-token', clientLabel: 'T', permissionMode: 'ui', approveMode: 'manual', port: 0 }),
    port: () => 0
  })
  await transport.start()
  const port = transport.port()!
  const base = `http://127.0.0.1:${port}/mcp`
  const init = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer sse-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sse-hold', version: '1' } } })
  })
  assert.equal(init.status, 200)
  const sid = init.headers.get('mcp-session-id')!
  // 打开 SSE GET 并保持（不消费、不关闭）——模拟 Codex/Claude Code 的连接行为
  const ssePromise = fetch(base, {
    headers: { Accept: 'text/event-stream', Authorization: 'Bearer sse-token', 'Mcp-Session-Id': sid }
  })
  await new Promise(r => setTimeout(r, 200))
  const stopResult = await Promise.race([
    transport.stop().then(() => 'resolved'),
    new Promise(r => setTimeout(() => r('timeout'), 4000))
  ])
  assert.equal(stopResult, 'resolved', 'stop() must resolve while a client SSE stream is still open')
  assert.equal(transport.port(), null)
  await ssePromise.catch(() => {}) // 连接被服务器关闭 → fetch 抛错，属预期
  await inbound.stop()
}

// ---------- manager：生命周期（默认关闭 / 自动 token 生效且可鉴权 / token 变更重启） ----------

{
  // 应用启动时 manager 已由数据库配置构造，随后 configure 会再次收到同一对象。
  // 配置等价不能掩盖“enabled 但 runtime 仍 stopped”的状态差异。
  const enabledAtStartup = {
    enabled: true, token: 'startup-token', clientLabel: 'Codex',
    permissionMode: 'ui' as const, approveMode: 'manual' as const, port: 0
  }
  const manager = new McpServerManager(
    service,
    new BotSessionAdapter({ sessions: service }),
    permissions,
    sharedRegistry,
    enabledAtStartup
  )
  await manager.configure(enabledAtStartup)
  assert.equal(manager.status().state, 'connected',
    'an enabled persisted config starts even when it is semantically equal to constructor settings')
  assert.ok(manager.status().url)
  await manager.stop()
}

{
  // 固定端口是客户端配置的一部分；占用时必须明确失败，不能静默漂移到随机端口。
  const blocker = net.createServer()
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', () => resolve())
  })
  const occupiedPort = (blocker.address() as AddressInfo).port
  const disabled = {
    enabled: false, token: 'fixed-token', clientLabel: 'Codex',
    permissionMode: 'ui' as const, approveMode: 'manual' as const, port: occupiedPort
  }
  const manager = new McpServerManager(
    service,
    new BotSessionAdapter({ sessions: service }),
    permissions,
    sharedRegistry,
    disabled
  )
  await assert.rejects(
    manager.configure({ ...disabled, enabled: true }),
    error => (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
  )
  assert.equal(manager.status().state, 'failed')
  assert.equal(manager.status().url, null)
  await manager.stop()
  await new Promise<void>(resolve => blocker.close(() => resolve()))
}

{
  // 固定端口：模拟用户要稳定地址的场景；token 变更在同一端口上验证"旧 token 立即失效"。
  const PORT = 18923
  const base = { clientLabel: 'Codex', permissionMode: 'ui', approveMode: 'manual' as const }
  const manager = new McpServerManager(
    service,
    new BotSessionAdapter({ sessions: service }),
    permissions,
    sharedRegistry,
    { enabled: false, token: '', ...base, port: 0 }
  )

  // 同端点重启会触发 undici 连接池里的 stale socket：真实 MCP 客户端对
  // ECONNRESET 会透明重连，这里以一次重试模拟（产品侧 stop 行为本身正确，
  // 见 probe——closeAllConnections 后池可正常复用）。
  const post = async (url: string, token: string): Promise<number> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-06-18', clientInfo: { name: 'manager-test', version: '1' }, capabilities: {} }
          })
        })
        return res.status
      } catch (error) {
        const cause = (error as { cause?: { code?: string } })?.cause
        if (cause?.code === 'ECONNRESET' || cause?.code === 'ECONNREFUSED') await new Promise(r => setTimeout(r, 30))
        else throw error
      }
    }
    throw new Error('ping did not succeed within retries')
  }

  // 默认关闭：不启动传输，不回显 token
  assert.deepEqual(manager.status(), { state: 'stopped', url: null, token: null, error: null },
    'disabled by default — no transport, no token echo')

  // 启用 + 自动 token（留空）：生成生效 token，status 回显它，且该 token 能通过真实鉴权
  await manager.configure({ enabled: true, token: '', ...base, port: PORT })
  const running = manager.status()
  assert.equal(running.state, 'connected')
  assert.equal(running.url, `http://127.0.0.1:${PORT}/mcp`, 'a fixed port stays stable across restarts')
  assert.ok(running.token && running.token.length >= 16, 'auto-generated token is echoed for the connection command')
  assert.equal(await post(running.url!, running.token!), 200,
    'the echoed auto token actually authenticates (the value the copy-command uses)')
  assert.equal(await post(running.url!, 'wrong-token'), 401, 'a wrong token is still rejected')

  // token 变更（同端口）→ 重启：新 token 生效，旧 token 在同一端点上立即 401
  await manager.configure({ enabled: true, token: 'second-token', ...base, port: PORT })
  const after = manager.status()
  assert.equal(after.token, 'second-token')
  assert.equal(after.url, running.url, 'a token-only change keeps the stable endpoint')
  assert.equal(await post(running.url!, running.token!), 401,
    'a token change revokes the previous token immediately')
  assert.equal(await post(after.url!, 'second-token'), 200)

  // 关闭：传输停掉，token 回显作废
  await manager.stop()
  assert.equal(manager.status().state, 'stopped')
  assert.equal(manager.status().token, null, 'token is not echoed once stopped')
}

console.log('MCP inbound server tests passed')
