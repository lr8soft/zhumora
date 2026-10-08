import assert from 'node:assert/strict'
import { AgentAbortedError, type AppSettings, type Session, type UIMessage, type ToolCall } from '../src/shared/types.ts'
import { SessionService } from '../src/main/agent/sessionService.ts'
import type { SessionStore } from '../src/main/agent/sessionContracts.ts'
import { PermissionBroker, type PermissionRequest } from '../src/main/agent/permissionBroker.ts'
import type { AgentEventCallbacks, AgentRunOptions } from '../src/main/agent/runner.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { createSubagentTools } from '../src/main/tools/subagent.ts'
import { resolveSubagentModel, validateSubagentRequest } from '../src/main/agent/subagentPolicy.ts'
import { executeToolCall } from '../src/main/agent/toolExecutor.ts'
import { runToolCallPhase } from '../src/main/agent/turnEffects.ts'
import { WorkingConversation } from '../src/main/agent/workingConversation.ts'
import { LoopDetector, DEFAULT_LOOP_CONFIG } from '../src/main/agent/loopDetector.ts'

const providers = [
  { id: 'a', name: 'A', baseUrl: 'https://a.test/v1', apiKey: 'secret-a', defaultModel: 'a-default', enabled: true },
  { id: 'b', name: 'B', baseUrl: 'https://b.test/v1', apiKey: 'secret-b', defaultModel: 'b-default', enabled: true },
  { id: 'off', name: 'Off', baseUrl: 'https://off.test', apiKey: 'secret-off', defaultModel: 'off', enabled: false }
]
const request = { description: 'research', prompt: 'inspect module' }
assert.deepEqual(resolveSubagentModel(providers, { providerId: 'a', model: 'custom-a' }, request), { providerId: 'a', model: 'custom-a' })
assert.deepEqual(resolveSubagentModel(providers, { providerId: 'a', model: 'custom-a' }, { ...request, providerId: 'b' }), { providerId: 'b', model: 'b-default' })
assert.throws(() => resolveSubagentModel(providers, { providerId: 'a', model: 'm' }, { ...request, providerId: 'off' }), /disabled/)
assert.throws(() => validateSubagentRequest({ description: '', prompt: 'x' }), /description/)
assert.throws(() => validateSubagentRequest({ description: 'x', prompt: 'x'.repeat(24001) }), /prompt/)

function fixture() {
  let sequence = 0
  const sessions = new Map<string, Session>()
  const messages = new Map<string, UIMessage[]>()
  const settings = { providers, activeProviderId: 'a', workspacePath: 'D:/shared', memoryEnabled: false, maxRounds: 20 } as AppSettings
  const store: SessionStore = {
    createSession(title = 'root', workspacePath, subagent) {
      const id = `s${++sequence}`
      const session: Session = { id, title, workspacePath, subagent, origin: 'renderer', createdAt: 1, updatedAt: 1,
        messageCount: 0, avatarEnabled: false, ttsEnabled: false }
      sessions.set(id, session); messages.set(id, []); return session
    },
    getSessions: () => [...sessions.values()], getSettings: () => settings, getSession: id => sessions.get(id) ?? null,
    updateSessionTitle: () => {}, updateSessionWorkspace: () => {},
    deleteSession: id => { sessions.delete(id); messages.delete(id) },
    getOrCreateBotSession: () => { throw new Error('unused') }, getMessages: id => [...messages.get(id)!],
    addMessage: message => { assert.ok(sessions.has(message.sessionId), 'no write after deletion'); messages.get(message.sessionId)!.push(message) },
    getSessionCompaction: () => null, setSessionCompaction: () => {}, tryUpdateSessionTitleIfDefault: () => false, addTokenUsage: () => {}
  }
  const running = new Map<string, { options: AgentRunOptions; callbacks: AgentEventCallbacks; resolve: () => void; reject: (error: unknown) => void }>()
  const permissions = new PermissionBroker()
  const pending: PermissionRequest[] = []
  permissions.addPresenter({ present: input => { pending.push(input) } })
  const tools = new ToolRegistry()
  for (const [name, permission, alwaysConfirm] of [['read', 'safe', false], ['write', 'normal', false], ['boundary', 'dangerous', true]] as const) {
    tools.register(name, { permission, alwaysConfirm, definition: { type: 'function', function: { name, description: name, parameters: {} } },
      execute: async () => ({ content: 'ok' }) }, name === 'read' ? 'mcp:test' : 'builtin')
  }
  let stuck = false
  let delayPrompt: (() => Promise<string>) | undefined
  const service = new SessionService({ store, tools, permissions, getSkillsPrompt: () => '', getMcpStatus: () => [],
    getSystemPromptExtra: async id => sessions.get(id)?.subagent && delayPrompt ? delayPrompt() : '',
    executeAgent: async (options, callbacks) => new Promise((resolve, reject) => {
      running.set(options.sessionId!, { options, callbacks, resolve: () => resolve([]), reject })
      if (!(stuck && sessions.get(options.sessionId!)?.subagent)) {
        options.signal?.addEventListener('abort', () => reject(new AgentAbortedError()), { once: true })
      }
    }), fetchContextWindow: async () => 32000, completeText: async () => '',
    planAutoCompact: async () => ({ beforeTokens: 0, afterTokens: 0, compressedCount: 0, keptCount: 0, keptOffset: 0, summary: null }) })
  for (const { name, handler } of createSubagentTools(service)) tools.register(name, handler)
  const finish = (id: string, text = 'delivered') => {
    const run = running.get(id)!
    run.callbacks.onAssistantMessage?.(text, []); run.callbacks.onComplete?.(); run.resolve()
  }
  const root = async (title = 'root', approveMode: 'manual' | 'auto' | 'full' = 'auto') => {
    const session = service.createSession(title, 'D:/parent-workspace')
    const handle = await service.sendMessage({ sessionId: session.id, message: { text: 'private parent history' },
      providerId: 'a', modelOverride: 'custom-a', reasoningEffort: 'high', approveMode, sourcePrompt: 'External source rules remain authoritative.' })
    void handle.completion.catch(() => {})
    const options = running.get(session.id)!.options
    return { session, handle, options, scope: service.getSubagentScope(session.id, options.signal) }
  }
  return { service, tools, permissions, pending, sessions, messages, running, finish, root,
    makeStuck: () => { stuck = true }, delayPrompt: (fn: () => Promise<string>) => { delayPrompt = fn } }
}

type Result = { task_id: string; session_id: string; status: string; reply?: string; truncated?: boolean }
const result = (value: object) => value as Result

// Sequential parent tool execution must still start two overlapping child runs, with legal tool-result order.
{
  const f = fixture(); const parent = await f.root(); const other = await f.root('unrelated')
  const providerOutput = await f.tools.get('list_subagent_providers')!.handler.execute({}, { workspacePath: '' })
  assert.doesNotMatch(JSON.stringify(providerOutput), /secret|baseUrl|apiKey|off/)
  const calls: ToolCall[] = ['a', 'b'].map((providerId, i) => ({ id: `call${i}`, type: 'function', function: {
    name: 'spawn_subagent', arguments: JSON.stringify({ ...request, providerId }) } }))
  const conversation = new WorkingConversation('system')
  conversation.append({ role: 'assistant', content: null, tool_calls: calls }, 'assistant')
  await runToolCallPhase(calls, 'assistant', { conversation, toolsRegistry: f.tools, workspacePath: 'D:/parent-workspace',
    sessionId: parent.session.id, signal: parent.options.signal, permissionCheck: parent.options.permissionCheck,
    loopDetector: new LoopDetector(), loopConfig: DEFAULT_LOOP_CONFIG, hardStop: null, cb: {} })
  const children = conversation.messages.slice(2).map(message => JSON.parse(message.content as string) as Result)
  assert.deepEqual(conversation.messages.slice(2).map(message => message.tool_call_id), ['call0', 'call1'])
  assert.equal(children.length, 2); assert.ok(children.every(child => f.service.isRunning(child.session_id)))
  const a = f.running.get(children[0].session_id)!.options; const b = f.running.get(children[1].session_id)!.options
  assert.equal(a.provider.id, 'a'); assert.equal(a.modelOverride, 'custom-a'); assert.equal(a.reasoningEffort, 'high')
  assert.equal(b.provider.id, 'b'); assert.equal(b.modelOverride, 'b-default'); assert.equal(b.reasoningEffort, undefined)
  assert.equal(b.workspacePath, 'D:/parent-workspace')
  assert.equal(b.messages.length, 1); assert.equal(b.messages[0].content, request.prompt)
  assert.ok(b.systemPromptExtra?.includes('External source rules remain authoritative.'))
  assert.deepEqual(b.promptRuntime?.tools, parent.options.promptRuntime?.tools, 'full tool snapshots remain intact')
  await assert.rejects(other.scope.wait([children[0].task_id], 0), /owned/)
  assert.throws(() => f.service.getSubagentScope(children[0].session_id, a.signal), /Nested/)
  await assert.rejects(f.service.sendMessage({ sessionId: children[0].session_id, message: { text: 'inject' } }), /running|owned/)
  f.finish(children[0].session_id, 'first'); f.finish(children[1].session_id, 'x'.repeat(14000))
  const done = (await parent.scope.wait(children.map(child => child.task_id))) as Result[]
  assert.equal(done[0].reply, 'first'); assert.equal(done[1].reply?.length, 12000); assert.equal(done[1].truncated, true)
  assert.equal(f.messages.get(children[1].session_id)!.at(-1)!.content.length, 14000, 'bounded return does not truncate persisted history')
  const continued = result(await parent.scope.continue(children[0].task_id, 'follow-up'))
  assert.equal(continued.session_id, children[0].session_id); assert.notEqual(continued.task_id, children[0].task_id)
  assert.equal(f.running.get(continued.session_id)!.options.messages.length, 3)
  await parent.scope.cancel(children[0].task_id)
  assert.equal(f.service.isRunning(continued.session_id), true, 'old completed handle cannot cancel a new turn')
  await assert.rejects(parent.scope.continue(children[0].task_id, 'stale'), /Stale/)
  await parent.scope.cancel(continued.task_id)
  assert.equal(f.service.isRunning(other.session.id), true)
  const unjoined = result(await parent.scope.spawn(request))
  f.finish(parent.session.id)
  await parent.handle.completion
  assert.equal(f.service.isRunning(unjoined.session_id), false, 'normal parent completion cancels unfinished children')
  assert.ok(f.service.getSession(unjoined.session_id), 'child histories survive parent completion')
  assert.throws(() => f.service.getSubagentScope(parent.session.id, parent.options.signal), AgentAbortedError)
  await f.service.stopAll(); f.permissions.dispose()
}

// Capacity is reserved before async startup; invalid routing never creates phantom child sessions.
{
  const f = fixture(); const parent = await f.root()
  await assert.rejects(parent.scope.spawn({ ...request, providerId: 'missing' }), /unknown/)
  assert.equal(f.sessions.size, 1)
  const children = await Promise.all(Array.from({ length: 4 }, () => parent.scope.spawn(request).then(result)))
  await assert.rejects(parent.scope.spawn(request), /concurrency/)
  await assert.rejects(parent.scope.continue(children[0].task_id, 'busy'), /busy/)
  await assert.rejects(parent.scope.wait([children[0].task_id], NaN), /wait_ms/)
  for (const child of children) await parent.scope.cancel(child.task_id)
  let child = children[0]
  for (let i = 0; i < 4; i++) {
    child = result(await parent.scope.continue(child.task_id, `turn ${i}`))
    f.finish(child.session_id); await parent.scope.wait([child.task_id])
  }
  await assert.rejects(parent.scope.spawn(request), /turn limit/)
  await f.service.stopAll(); f.permissions.dispose()
}

// Parent policy is live; even full mode cannot auto-approve capability changes. Cancellation clears pending requests.
{
  const f = fixture(); const parent = await f.root('permissions', 'manual')
  const context = { sessionId: parent.session.id, signal: parent.options.signal, workspacePath: 'D:/parent-workspace' }
  const spawn = executeToolCall({ toolCall: { id: 'spawn', type: 'function', function: { name: 'spawn_subagent', arguments: JSON.stringify(request) } },
    registry: f.tools, context, permissionCheck: parent.options.permissionCheck })
  assert.equal(f.sessions.size, 1, 'delegation approval occurs before child creation')
  f.permissions.respond(f.pending.at(-1)!.id, true)
  const child = JSON.parse((await spawn).displayContent) as Result
  const options = f.running.get(child.session_id)!.options
  const normal = options.permissionCheck!('write', {})
  assert.equal(f.permissions.hasPending(child.session_id), true)
  assert.equal((await parent.scope.wait([child.task_id], 0) as Result[])[0].status, 'awaiting_permission')
  f.permissions.respond(f.pending.at(-1)!.id, false); assert.equal(await normal, false)
  f.service.setApproveMode(parent.session.id, 'full')
  assert.equal(await options.permissionCheck!('write', {}), true)
  const boundary = options.permissionCheck!('boundary', {})
  const pendingId = f.pending.at(-1)!.id
  assert.equal(f.permissions.hasPending(child.session_id), true)
  f.service.abort(parent.session.id)
  await assert.rejects(parent.handle.completion, AgentAbortedError)
  assert.equal(await boundary, false); assert.equal(f.permissions.respond(pendingId, true), false)
  assert.equal(f.service.isRunning(child.session_id), false)
  f.permissions.dispose()
}

// The user may abort during an approval callback: the permitted tool must still not execute.
{
  const tools = new ToolRegistry(); let executed = false; const controller = new AbortController()
  tools.register('write', { definition: { type: 'function', function: { name: 'write', description: '', parameters: {} } },
    execute: async () => { executed = true; return { content: 'bad' } } })
  const output = await executeToolCall({ toolCall: { id: 'call', type: 'function', function: { name: 'write', arguments: '{}' } },
    registry: tools, context: { workspacePath: '', signal: controller.signal },
    permissionCheck: async () => { controller.abort(); return true } })
  assert.equal(executed, false); assert.equal(output.llmMessage.tool_call_id, 'call'); assert.equal(output.isError, true)
}

// A stuck child cannot hold parent deletion forever or write late results after forced cleanup.
{
  const f = fixture(); const parent = await f.root(); f.makeStuck()
  const child = result(await parent.scope.spawn(request)); const callbacks = f.running.get(child.session_id)!.callbacks
  await f.service.deleteSession(parent.session.id)
  assert.equal(f.service.isRunning(child.session_id), false)
  assert.equal(f.service.getSession(parent.session.id), null)
  const before = f.messages.get(child.session_id)!.length
  callbacks.onAssistantMessage?.('late', []); callbacks.onToolResult?.('late-call', 'write', 'late', false, 0); callbacks.onComplete?.()
  assert.equal(f.messages.get(child.session_id)!.length, before)
  f.permissions.dispose()
}

// Startup still awaiting prompt preparation is cancelled without persisting the child's user message.
{
  const f = fixture(); const parent = await f.root(); let release!: (text: string) => void
  f.delayPrompt(() => new Promise(resolve => { release = resolve }))
  const spawning = parent.scope.spawn(request)
  const rejected = assert.rejects(spawning, AgentAbortedError)
  await Promise.resolve(); f.service.abort(parent.session.id); release('prepared too late')
  await rejected; await assert.rejects(parent.handle.completion, AgentAbortedError)
  const child = [...f.sessions.values()].find(session => session.subagent)!
  assert.equal(f.messages.get(child.id)!.length, 0)
  assert.equal(f.service.isRunning(child.id), false)
  f.permissions.dispose()
}

// Cancellation must finish the parent tool phase even if prompt preparation never responds.
{
  const f = fixture(); const parent = await f.root()
  f.delayPrompt(() => new Promise<string>(() => {}))
  const call: ToolCall = { id: 'blocked-spawn', type: 'function', function: {
    name: 'spawn_subagent', arguments: JSON.stringify(request) } }
  const conversation = new WorkingConversation('system')
  conversation.append({ role: 'assistant', content: null, tool_calls: [call] }, 'assistant')
  const phase = runToolCallPhase([call], 'assistant', { conversation, toolsRegistry: f.tools, workspacePath: 'D:/shared',
    sessionId: parent.session.id, signal: parent.options.signal, permissionCheck: parent.options.permissionCheck,
    loopDetector: new LoopDetector(), loopConfig: DEFAULT_LOOP_CONFIG, hardStop: null, cb: {} })
  await Promise.resolve(); await Promise.resolve()
  f.service.abort(parent.session.id)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([phase, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('spawn tool ignored cancellation')), 300) })])
    assert.equal(conversation.messages.at(-1)?.tool_call_id, call.id, 'cancelled spawn still closes its tool-call group')
    await assert.rejects(parent.handle.completion, AgentAbortedError)
    assert.equal(f.service.runningSessionIds().length, 0)
  } finally {
    clearTimeout(timer); await f.service.stopAll(); f.permissions.dispose()
  }
}

// The same deadline covers task status and cleanup; an aborted, stuck child must not block a zero wait.
{
  const f = fixture(); const parent = await f.root(); f.makeStuck()
  const child = result(await parent.scope.spawn(request)); f.service.abort(child.session_id)
  try {
    const began = Date.now(); const snapshot = await parent.scope.wait([child.task_id], 0)
    assert.equal(snapshot[0].status, 'aborted')
    assert.equal(snapshot[0].settled, false, 'aborted status does not claim the stuck runner has been released')
    assert.ok(Date.now() - began < 300, 'wait_ms=0 must not wait for the two-second cleanup fallback')
    const positive = Date.now(); await parent.scope.wait([child.task_id], 25)
    assert.ok(Date.now() - positive < 300, 'cleanup must respect the remaining wait budget')
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}

// Public completion must follow child cleanup and parent release, with no success after an abort.
{
  const f = fixture(); let parentId = ''; let childId = ''
  const completed: Array<{ parentRunning: boolean; childRunning: boolean }> = []
  f.service.events.subscribe({ complete: id => {
    if (id === parentId) completed.push({ parentRunning: f.service.isRunning(id), childRunning: f.service.isRunning(childId) })
  } })
  const parent = await f.root(); parentId = parent.session.id; f.makeStuck()
  childId = result(await parent.scope.spawn(request)).session_id
  f.finish(parentId)
  assert.equal(completed.length, 0, 'a generated answer is not public completion while children are draining')
  await parent.handle.completion
  assert.deepEqual(completed, [{ parentRunning: false, childRunning: false }])
  f.permissions.dispose()
}

// Abort during final draining suppresses success; ordinary errors retain their original rejection.
{
  const f = fixture(); let parentId = ''; const completions: string[] = []
  f.service.events.subscribe({ complete: id => { if (id === parentId) completions.push(id) } })
  const parent = await f.root(); parentId = parent.session.id; f.makeStuck()
  await parent.scope.spawn(request); f.finish(parentId); await Promise.resolve()
  f.service.abort(parentId)
  await assert.rejects(parent.handle.completion, AgentAbortedError)
  assert.deepEqual(completions, []); f.permissions.dispose()
}
{
  const f = fixture(); let parentId = ''; let childId = ''; const errors: Error[] = []
  f.service.events.subscribe({ error: (id, error) => {
    if (id === parentId) {
      assert.equal(f.service.isRunning(parentId), false); assert.equal(f.service.isRunning(childId), false); errors.push(error)
    }
  } })
  const parent = await f.root(); parentId = parent.session.id; f.makeStuck()
  childId = result(await parent.scope.spawn(request)).session_id
  const failure = new Error('original provider failure'); f.running.get(parentId)!.reject(failure)
  await assert.rejects(parent.handle.completion, error => error === failure)
  assert.deepEqual(errors, [failure])
  const primitive = await f.root('primitive failure')
  f.running.get(primitive.session.id)!.reject('raw provider failure')
  await assert.rejects(primitive.handle.completion, error => error === 'raw provider failure')
  f.permissions.dispose()
}

// Spawn/continue startup failures are tool errors; querying a failed child remains a successful wait.
{
  const f = fixture(); const parent = await f.root()
  const child = result(await parent.scope.spawn(request)); f.finish(child.session_id); await parent.scope.wait([child.task_id])
  f.delayPrompt(async () => { throw new Error('prompt preparation failed') })
  const context = { sessionId: parent.session.id, signal: parent.options.signal, workspacePath: 'D:/shared' }
  const spawned = await f.tools.get('spawn_subagent')!.handler.execute(request, context)
  const continued = await f.tools.get('continue_subagent')!.handler.execute({ task_id: child.task_id, prompt: 'more' }, context)
  assert.equal(typeof spawned, 'object'); assert.equal(typeof continued, 'object')
  if (typeof spawned !== 'string' && typeof continued !== 'string') {
    assert.equal(spawned.isError, true); assert.equal(continued.isError, true)
    const failed = JSON.parse(spawned.content) as Result
    assert.equal((JSON.parse(spawned.content) as { settled: boolean }).settled, true)
    const waited = await f.tools.get('wait_subagents')!.handler.execute({ task_ids: [failed.task_id], wait_ms: 0 }, context)
    assert.equal(typeof waited, 'object')
    if (typeof waited !== 'string') assert.notEqual(waited.isError, true, 'a failed child does not mean the wait tool failed')
  }
  await f.service.stopAll(); f.permissions.dispose()
}

console.log('Subagent parallelism, model routing, isolation, permissions, limits and cancellation tests passed')
