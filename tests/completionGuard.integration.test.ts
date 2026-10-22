import assert from 'node:assert/strict'
import { register } from 'node:module'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { createPersistedAgentCallbacks } from '../src/main/agent/persistedCallbacks.ts'
import { AgentAbortedError, type UIMessage, type ChatMessage } from '../src/shared/types.ts'

register('./helpers/providerBusyLoader.mjs', import.meta.url)
const { runAgent } = await import('../src/main/agent/runner.ts')
const originalFetch = globalThis.fetch
const provider = { id: 'guard', name: 'guard', baseUrl: 'https://fixture.invalid/v1',
  apiKey: '', defaultModel: 'fixture', enabled: true }
const frame = (delta: object, finish_reason: string | null = null) =>
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
const ended = (delta: object, finish = 'stop') => new Response(frame(delta) + frame({}, finish) + 'data: [DONE]\n\n')
const tool = { tool_calls: [{ index: 0, id: 'write-once', type: 'function', function: { name: 'write', arguments: '{}' } }] }
type Request = { messages: ChatMessage[]; tools?: unknown[]; reasoning_effort?: string }

function fixture(options: { guidance?: boolean; signal?: AbortSignal; reasoningEffort?: 'high';
  onCoordination?: () => void; respond?: (request: Request, attempt: number) => Response | undefined } = {}) {
  const saved: UIMessage[] = []; const requests: Request[] = []
  let executed = 0; let completed = 0; let id = 0; let pendingGuidance = false
  const cb = createPersistedAgentCallbacks('s', { addMessage: m => saved.push(m),
    updateMessageGeneration(messageId, generation) {
      const message = saved.find(m => m.id === messageId)
      if (message) message.generation = generation
    }, addTokenUsage() {} }, () => 'm' + ++id, { complete() { completed++ } })
  const registry = new ToolRegistry()
  registry.register('write', { definition: { type: 'function', function: { name: 'write', description: '', parameters: {} } },
    permission: 'normal', execute: async () => { executed++; return { content: 'saved' } } })
  globalThis.fetch = async (_url, init) => {
    const request: Request = JSON.parse(String(init?.body)); requests.push(request)
    assert.ok(!String(request.messages[0]?.content).startsWith('[Completion review]'), 'ordinary completion must not ask another LLM judge')
    const custom = options.respond?.(request, requests.length)
    if (custom) return custom
    if (requests.length === 2) pendingGuidance = options.guidance === true
    return requests.length === 1 ? ended(tool, 'tool_calls')
      : ended({ content: requests.length === 2 ? '继续分析实现策略（cl' : 'Implementation and validation are complete.' })
  }
  const run = async (maxRounds = 20) => {
    try {
      return await runAgent({ provider, reasoningEffort: options.reasoningEffort,
        messages: [{ role: 'user', content: 'implement and validate' }], messageIds: ['u'], workspacePath: '',
        compaction: null, toolRegistry: registry, memoryEnabled: false, maxRounds, signal: options.signal,
        permissionCheck: async () => true,
        takeCoordinationMessages: finalizing => {
          if (!finalizing) return []
          options.onCoordination?.()
          if (!pendingGuidance) return []
          assert.equal(saved.at(-1)!.content, '继续分析实现策略（cl', 'persist assistant before coordinating input')
          pendingGuidance = false
          return [{ id: 'guidance', message: { role: 'user', content: 'New parent evidence' } }]
        } }, cb)
    } catch (error) {
      if (!(error instanceof AgentAbortedError)) cb.onError?.(error as Error)
      throw error
    }
  }
  return { run, cb, saved, requests, count: () => ({ executed, completed }) }
}

try {
  {
    const f = fixture(); await f.run()
    assert.equal(f.requests.length, 2, 'tool round plus actual answer, with no extra review request')
    assert.deepEqual(f.count(), { executed: 1, completed: 1 })
    assert.equal(f.saved.at(-1)!.content, '继续分析实现策略（cl', 'normal stop is not judged by punctuation or a second model')
    assert.equal(f.saved.at(-1)!.generation?.status, 'complete')
    assert.ok(f.saved.every(m => !['checking', 'unverified'].includes(m.generation?.status ?? '')))
    assert.equal(new Set(f.saved.map(m => m.id)).size, f.saved.length)
  }
  {
    const f = fixture({ guidance: true }); await f.run()
    assert.equal(f.requests.length, 3)
    assert.deepEqual(f.count(), { executed: 1, completed: 1 })
    assert.ok(f.requests[2].messages.some(m => m.role === 'user' && m.content === 'New parent evidence'))
    assert.equal(f.saved.filter(m => m.role === 'tool').length, 1)
    const at = f.requests[2].messages.findIndex(m => m.tool_calls?.length)
    assert.equal(f.requests[2].messages[at + 1].tool_call_id, 'write-once')
  }
  for (const moment of ['persist', 'coordination'] as const) {
    const abort = new AbortController()
    let coordinated = 0
    const f = fixture({ signal: abort.signal, guidance: moment === 'coordination',
      onCoordination: () => { coordinated++; if (moment === 'coordination') abort.abort() } })
    const persist = f.cb.onAssistantMessage
    f.cb.onAssistantMessage = (...args) => {
      const id = persist?.(...args)
      if (args[1].length === 0 && moment === 'persist') abort.abort()
      return id ?? null
    }
    await assert.rejects(f.run(), AgentAbortedError)
    assert.equal(f.count().completed, 0)
    assert.equal(f.count().executed, 1)
    assert.equal(f.saved.at(-1)!.generation?.termination, 'aborted')
    assert.equal(f.saved.at(-1)!.generation?.status, 'incomplete')
    assert.ok(!f.saved.some(m => m.status === 'error'))
    assert.equal(coordinated, moment === 'persist' ? 0 : 1, 'already cancelled runs must not deliver more guidance')
  }
  for (const content of ['', 'reasoning-only']) {
    const f = fixture({ respond: () => ended(content ? { reasoning_content: content } : {}) })
    await assert.rejects(f.run(), { name: 'AgentCompletionError', reason: 'empty' })
    assert.equal(f.requests.length, 3, 'empty delivery still has only two bounded continuations')
    assert.deepEqual(f.count(), { executed: 0, completed: 0 })
  }
  {
    const f = fixture()
    await assert.rejects(f.run(1), { name: 'AgentCompletionError', reason: 'limit' })
    assert.equal(f.requests.length, 2)
    assert.deepEqual(f.count(), { executed: 1, completed: 0 })
    assert.equal(f.requests[1].tools, undefined)
    assert.ok(f.saved.some(m => m.generation?.status === 'limit'))
  }
  {
    const abort = new AbortController()
    const f = fixture({ signal: abort.signal })
    const persist = f.cb.onAssistantMessage
    f.cb.onAssistantMessage = (...args) => {
      const id = persist?.(...args)
      if (args[3]?.status === 'limit') abort.abort()
      return id ?? null
    }
    await assert.rejects(f.run(1), AgentAbortedError)
    assert.deepEqual(f.count(), { executed: 1, completed: 0 })
    assert.equal(f.requests.length, 2)
    assert.equal(f.saved.at(-1)!.generation?.status, 'incomplete')
    assert.equal(f.saved.at(-1)!.generation?.termination, 'aborted')
    assert.ok(!f.saved.some(m => m.status === 'error'), 'cancellation during finalization persistence stays cancellation')
  }
  {
    let rejected = 0
    const f = fixture({ reasoningEffort: 'high', respond(request) {
      if (request.reasoning_effort) { rejected++; return new Response('Unsupported parameter: reasoning_effort', { status: 400 }) }
      return ended({ content: 'done' })
    } })
    await f.run()
    assert.equal(rejected, 1)
    assert.equal(f.requests.length, 2, 'request-local compatibility downgrade does not add a review request')
    assert.equal(f.count().completed, 1)
  }
} finally { globalThis.fetch = originalFetch }
console.log('Completion guard: direct normal completion, bounded empty recovery, coordination, abort and limits passed')
