import assert from 'node:assert/strict'
import { register } from 'node:module'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { AgentAbortedError, type AppSettings, type Session, type ChatMessage, type UIMessage } from '../src/shared/types.ts'
import type { SessionStore } from '../src/main/agent/sessionContracts.ts'
import { SessionService } from '../src/main/agent/sessionService.ts'
import { PermissionBroker } from '../src/main/agent/permissionBroker.ts'
import { createPersistedAgentCallbacks } from '../src/main/agent/persistedCallbacks.ts'
import { createMcpTaskSession } from '../src/main/agent/taskProtocol.ts'

register('./helpers/runnerCollaborationLoader.mjs', import.meta.url)
const { runAgent } = await import('../src/main/agent/runner.ts')
const { streamChat } = await import('../src/main/llm/provider.ts')
const originalFetch = globalThis.fetch
const provider = { id: 'test', name: 'test', baseUrl: 'https://fixture.invalid/v1', apiKey: '', defaultModel: 'test', enabled: true }
const frame = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const tool = (id: string) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'write', arguments: '{}' } }] })
const response = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
const ended = (delta: object, finish = 'stop') => response(frame(delta) + frame({}, finish) + 'data: [DONE]\n\n')

function fixture() {
  const saved: UIMessage[] = []; const requests: { messages: ChatMessage[]; tools?: unknown[] }[] = []
  let completed = 0; let id = 0; let executed = 0
  const task = createMcpTaskSession('task')
  const cb = createPersistedAgentCallbacks('session', { addMessage: m => saved.push(m), addTokenUsage() {} },
    () => `m${++id}`, { ...task.sink, complete: (...args) => { completed++; task.sink.complete?.(...args) } })
  const registry = new ToolRegistry()
  registry.register('write', { definition: { type: 'function', function: { name: 'write', description: 'write', parameters: {} } },
    permission: 'normal', execute: async () => { executed++; return { content: 'saved' } } })
  const options = { provider, workspacePath: '', messages: [{ role: 'user' as const, content: 'do the work' }],
    messageIds: ['user'], compaction: null, memoryEnabled: false, maxRounds: 20, toolRegistry: registry,
    permissionCheck: async () => true }
  const fetches = (next: (index: number) => Response | Promise<Response>) => {
    globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(init!.body as string)); return next(requests.length) }
  }
  // SessionService owns error publication; model the same callback boundary for direct runner tests.
  const run = async (overrides: Partial<typeof options> & { signal?: AbortSignal } = {}) => {
    try { return await runAgent({ ...options, ...overrides }, cb) }
    catch (error) { if (!(error instanceof AgentAbortedError)) cb.onError?.(error as Error); throw error }
  }
  return { saved, requests, task, cb, options, fetches, run, completed: () => completed, executed: () => executed }
}

try {
  for (const reasoning of ['', 'thinking without an answer']) {
    const f = fixture(); f.fetches(() => ended({ reasoning_content: reasoning }))
    await assert.rejects(f.run(), { name: 'AgentCompletionError', reason: 'empty' })
    assert.equal(f.requests.length, 3); assert.equal(f.completed(), 0)
    assert.equal(f.task.status().status, 'failed', 'MCP must receive failure, never an empty success')
    assert.ok(f.saved.some(m => m.status === 'error'))
    assert.equal(f.saved.filter(m => m.reasoning === reasoning && !!reasoning).length, reasoning ? 3 : 0)
    assert.equal(f.saved.filter(m => m.status === 'done' && !m.content && !m.reasoning).length, 0)
    assert.ok(f.requests.slice(1).every(r => !r.messages.some(m => m.role === 'assistant' && !m.content)))
    assert.ok(f.requests.every(r => r.tools?.length === 1), 'recovery retains the complete tool snapshot')
  }
  {
    const f = fixture(); f.fetches(i => i === 1 ? ended(tool('done'), 'tool_calls') : i < 4 ? ended({}) : ended({ content: 'delivered' }))
    await f.run(); assert.equal(f.executed(), 1); assert.equal(f.completed(), 1)
    const history = f.requests[3].messages; const at = history.findIndex(m => m.tool_calls?.length)
    assert.equal(history[at + 1].role, 'tool'); assert.equal(history[at + 1].tool_call_id, 'done')
    assert.equal(f.saved.filter(m => m.role === 'tool').length, 1, 'successful side effects are never replayed')
    assert.equal(f.saved.at(-1)!.content, 'delivered')
  }
  for (const summary of [() => ended({}), () => ended({ reasoning: 'only thinking' }),
    () => ended({ content: 'cut short' }, 'length'), () => response(frame({ content: 'EOF' })),
    () => ended(tool('unexpected'), 'tool_calls'), () => ended({ content: 'blocked' }, 'content_filter'),
    () => new Response('unavailable', { status: 503 })]) {
    const f = fixture(); f.fetches(i => i === 1 ? ended(tool('done'), 'tool_calls') : summary())
    await assert.rejects(f.run({ maxRounds: 1 }))
    assert.equal(f.requests.length, 2, 'finalization has one bounded attempt')
    assert.equal(f.completed(), 0); assert.equal(f.executed(), 1)
    assert.equal(f.task.status().status, 'failed')
    assert.equal(f.requests[1].tools, undefined)
    for (const m of f.saved.filter(m => m.toolCalls?.length)) {
      assert.equal(f.saved.filter(t => t.role === 'tool' && t.toolCallId === m.toolCalls![0].id).length, 1)
    }
  }
  {
    const f = fixture(); f.fetches(i => i === 1 ? ended(tool('done'), 'tool_calls') : ended({ content: 'progress summary' }))
    await f.run({ maxRounds: 1 }); assert.equal(f.completed(), 1); assert.equal(f.saved.at(-1)!.content, 'progress summary')
  }
  {
    const f = fixture(); f.fetches(i => i % 2 ? ended({}) : ended(tool(`write-${i}`), 'tool_calls'))
    await assert.rejects(f.run({ maxRounds: 0 }), { name: 'AgentCompletionError', reason: 'empty' })
    assert.equal(f.requests.length, 9, 'the whole-run ceiling bounds alternating recovery and tool rounds')
    assert.equal(f.executed(), 4); assert.equal(f.completed(), 0)
  }
  {
    const f = fixture(); f.fetches(() => response(frame(tool('untrusted'))))
    await assert.rejects(f.run(), { name: 'AgentCompletionError', reason: 'stream' })
    assert.equal(f.requests.length, 3); assert.equal(f.executed(), 0); assert.equal(f.completed(), 0)
    assert.equal(f.saved.filter(m => m.role === 'tool').length, 3, 'each rejected tool group receives a placeholder')
    assert.ok(f.requests.slice(1).every(r => !r.messages.some(m => m.tool_calls?.length)), 'untrusted calls never reenter provider history')
  }
  {
    const f = fixture(); f.fetches(i => i === 1 ? response(frame({ content: 'partial answer' })) : ended({ content: 'completed answer' }))
    await f.run(); assert.equal(f.requests.length, 2); assert.equal(f.completed(), 1)
    assert.equal(f.requests[1].messages.at(-2)!.content, 'partial answer')
    assert.match(f.requests[1].messages.at(-1)!.content as string, /connection/)
    assert.ok(f.saved.some(m => m.content === 'partial answer'))
  }
  {
    const f = fixture(); const abort = new AbortController()
    f.fetches(() => { abort.abort(); return ended(tool('cancelled'), 'tool_calls') })
    await assert.rejects(f.run({ signal: abort.signal }), AgentAbortedError)
    assert.equal(f.requests.length, 1); assert.equal(f.executed(), 0); assert.equal(f.completed(), 0)
  }
  {
    const f = fixture(); const abort = new AbortController()
    f.fetches(i => {
      if (i === 1) return ended(tool('done'), 'tool_calls')
      abort.abort(); return ended(tool('must-not-run'), 'tool_calls')
    })
    await assert.rejects(f.run({ maxRounds: 1, signal: abort.signal }), AgentAbortedError)
    assert.equal(f.requests.length, 2); assert.equal(f.executed(), 1); assert.equal(f.completed(), 0)
  }
  {
    const f = fixture(); f.fetches(i => i === 1 ? ended(tool('denied'), 'tool_calls') : i === 2 ? ended({}) : ended({ content: 'permission was denied' }))
    await f.run({ permissionCheck: async () => false })
    assert.equal(f.executed(), 0); assert.equal(f.completed(), 1)
    assert.equal(f.saved.filter(m => m.role === 'tool').length, 1)
    assert.equal(f.saved.find(m => m.role === 'tool')!.status, 'error')
    assert.match(f.requests[2].messages.find(m => m.role === 'tool')!.content as string, /denied/i)
  }
  for (const body of ['', 'data: [DONE]\n\n', frame({ content: 'partial' }), frame({ reasoning: 'thinking' })]) {
    globalThis.fetch = async () => response(body)
    const r = await streamChat(provider, { messages: [] })
    assert.equal(r.streamInterrupted, true, 'EOF/DONE without finish_reason is incomplete even without visible output')
  }
  for (const body of ['data: {broken}\n\n',
    'data: {"choices":[{"message":{"content":"wrong protocol"}}]}\n\n']) {
    globalThis.fetch = async () => response(body)
    await assert.rejects(streamChat(provider, { messages: [] }), { name: 'ProviderStreamError' })
  }
  for (const maxRounds of [20, 1]) {
    const f = fixture()
    const error = { message: '模型上下文超限，输入 33000 tokens，上限 32768',
      type: 'invalid_request_error', code: 'context_length_exceeded', param: 'messages',
      metadata: { upstream: 'original detail private-key', retry_after: 30 } }
    f.fetches(i => i === 1 ? ended(tool('already-done'), 'tool_calls')
      : new Response(`data: ${JSON.stringify({ error })}\n\n`, { headers: { 'x-request-id': 'request-42' } }))
    await assert.rejects(f.run({ maxRounds }), e => {
      assert.ok(e instanceof Error && e.name === 'ProviderStreamError')
      assert.match(e.message, /模型上下文超限/)
      assert.match(e.message, /Provider: test\nModel: test\nRequest ID: request-42/)
      assert.ok(e.message.includes(JSON.stringify(error, null, 2)), 'complete upstream error survives without redaction/filtering')
      assert.equal(f.saved.at(-1)!.content, `Error: ${e.message}`, 'node details receive the same persisted error')
      return true
    })
    assert.equal(f.requests.length, 2, 'stream errors do not silently retry or restart tools')
    assert.equal(f.executed(), 1); assert.equal(f.completed(), 0)
    assert.equal(f.task.status().status, 'failed')
    assert.equal(f.saved.filter(m => m.role === 'tool').length, 1)
  }
  for (const mime of ['application/json', 'text/html']) {
    let cancelled = false
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame({ content: 'invalid MIME' }, 'stop'))) },
      cancel() { cancelled = true }
    }), { headers: { 'content-type': mime } })
    await assert.rejects(streamChat(provider, { messages: [] }), { name: 'ProviderStreamError' })
    assert.equal(cancelled, true, 'rejected responses also release the transport reader')
  }
  {
    // finish_reason suffices for endpoints omitting DONE, including a final UTF-8 chunk without newline.
    globalThis.fetch = async () => response(frame({ content: '兼容' }).trimEnd() + '\n\n' + frame({}, 'stop').trimEnd())
    const r = await streamChat(provider, { messages: [] }); assert.equal(r.content, '兼容'); assert.equal(r.streamInterrupted, undefined)
  }
  {
    const bytes = new TextEncoder().encode(': heartbeat\n\n' + frame({ content: '跨字节中文' }, 'stop'))
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    } }))
    assert.equal((await streamChat(provider, { messages: [] })).content, '跨字节中文')
  }
  {
    let cancelled = false
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame({ content: 'ok' }, 'stop')
        + 'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n')) },
      cancel() { cancelled = true }
    }))
    const r = await streamChat(provider, { messages: [] })
    assert.equal(r.content, 'ok'); assert.equal(r.usage?.total_tokens, 3); assert.equal(cancelled, true)
  }
  await sessionFailureIsolation()
} finally { globalThis.fetch = originalFetch }
console.log('Response recovery: empty exhaustion, finalization validation, stream integrity, tool/history preservation and cancellation passed')

async function sessionFailureIsolation() {
  const saved: UIMessage[] = []; let id = 0
  const sessions = ['empty', 'healthy'].map((key): Session => ({ id: key, title: key, createdAt: 1, updatedAt: 1,
    messageCount: 0, origin: 'renderer', avatarEnabled: false, ttsEnabled: false }))
  const store: SessionStore = {
    createSession() { throw new Error('unused') }, getSessions: () => sessions,
    getSession: key => sessions.find(s => s.id === key) ?? null,
    getSettings: () => ({ providers: [provider], activeProviderId: provider.id, workspacePath: '',
      memoryEnabled: false, subagentsEnabled: false, maxRounds: 20 } as AppSettings),
    getMessages: key => saved.filter(m => m.sessionId === key), addMessage: m => saved.push(m),
    getSessionCompaction: () => null, setSessionCompaction() {}, addTokenUsage() {},
    updateSessionTitle() {}, updateSessionWorkspace() {}, updateSessionModelSelection() {}, deleteSession() {},
    getOrCreateBotSession() { throw new Error('unused') }, tryUpdateSessionTitleIfDefault: () => false
  }
  const permissions = new PermissionBroker()
  const service = new SessionService({ store, permissions, tools: new ToolRegistry(), executeAgent: runAgent,
    fetchContextWindow: async () => 1000000, getSkillsPrompt: () => '', getMcpStatus: () => [],
    completeText: async () => '', generateMessageId: () => `session-${++id}`,
    planAutoCompact: async () => { throw new Error('unused') } })
  const failed = createMcpTaskSession('failed'); const healthy = createMcpTaskSession('healthy')
  const terminals: string[] = []; const counts = { empty: 0, healthy: 0 }
  service.events.subscribe({ error: key => { assert.equal(service.isRunning(key), false); terminals.push(`error:${key}`) },
    complete: key => { assert.equal(service.isRunning(key), false); terminals.push(`complete:${key}`) } })
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string)
    const empty = request.messages.some((m: ChatMessage) => m.content === 'empty task')
    counts[empty ? 'empty' : 'healthy']++
    return empty ? ended({ reasoning_content: 'thinking' }) : ended({ content: 'healthy answer' })
  }
  try {
    const first = await service.sendMessage({ sessionId: 'empty', message: { text: 'empty task' }, localEvents: failed.sink })
    void first.completion.catch(() => {})
    const second = await service.sendMessage({ sessionId: 'healthy', message: { text: 'healthy task' }, localEvents: healthy.sink })
    const [a, b] = await Promise.allSettled([first.completion, second.completion])
    assert.equal(a.status, 'rejected'); assert.equal(b.status, 'fulfilled')
    assert.deepEqual(counts, { empty: 3, healthy: 1 })
    assert.equal(failed.status().status, 'failed'); assert.equal(healthy.status().status, 'completed')
    assert.deepEqual(new Set(terminals), new Set(['error:empty', 'complete:healthy']))
    assert.deepEqual(service.runningSessionIds(), [])
    assert.equal(saved.filter(m => m.role === 'user').length, 2, 'synthetic recovery prompts never enter storage')
    assert.equal(new Set(saved.map(m => m.id)).size, saved.length, 'every record retains a unique authoritative ID')
    assert.ok(saved.some(m => m.sessionId === 'empty' && m.status === 'error'))
  } finally { await service.stopAll(); permissions.dispose() }
}
