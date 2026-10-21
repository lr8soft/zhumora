import assert from 'node:assert/strict'
import { register } from 'node:module'
import { HttpError, isRetriableError } from '../src/main/net/retryCore.ts'
import { isProviderBusyError, shouldRetryProviderError } from '../src/main/llm/providerRetry.ts'
import { ProviderStreamError } from '../src/main/llm/streamErrors.ts'
import { retryMessageKey, type AgentRetryEvent } from '../src/shared/agentRetry.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { createPersistedAgentCallbacks } from '../src/main/agent/persistedCallbacks.ts'
import type { UIMessage } from '../src/shared/types.ts'

register('./helpers/providerBusyLoader.mjs', import.meta.url)
const { streamChat, complete } = await import('../src/main/llm/provider.ts')
const { runAgent } = await import('../src/main/agent/runner.ts')
const { createIpcAgentEventSink } = await import('../src/main/ipc/agentCallbacks.ts')
const originalFetch = globalThis.fetch
const provider = { completionReview: false, id: 'busy', name: 'busy', baseUrl: 'https://fixture.invalid/v1', apiKey: '', defaultModel: 'test', enabled: true }
const params = { messages: [{ role: 'user' as const, content: 'work' }] }
const frame = (delta: object, finish = null as string | null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
const successful = () => new Response(frame({ content: 'ready' }, 'stop') + 'data: [DONE]\n\n')
const rateError = { message: '当前繁忙，请稍后再试', type: 'rate_limit_error', code: 429, param: null }
const sseError = (error: unknown) => new Response(`data: ${JSON.stringify({ error })}\n\n`)

assert.equal(isRetriableError(new HttpError(422, 'validation')), false, 'shared MCP/HTTP policy is unchanged')
assert.equal(shouldRetryProviderError(new HttpError(422, 'busy')), false)
assert.equal(isProviderBusyError(new HttpError(422, 'busy')), false)
for (const error of [rateError, { code: '429' }, { status: '429' }, { status_code: 429 },
  { type: 'rate_limit_error' }, { code: 'rate_limit_exceeded' }]) {
  const failure = new ProviderStreamError('provider', error)
  assert.equal(isProviderBusyError(failure), true); assert.equal(shouldRetryProviderError(failure), true)
}
for (const error of [new ProviderStreamError('payload'), new ProviderStreamError('content_type'),
  new ProviderStreamError('provider', { code: 400, message: 'network configuration' }),
  new ProviderStreamError('provider', { code: 401 }), new HttpError(403, 'forbidden'),
  new HttpError(422, 'invalid tool call arguments'),
  ...[{ code: 422 }, { code: '422' }, { status: '422' }, { status_code: 422 },
    { status: 422, type: 'rate_limit_error' }].map(error => new ProviderStreamError('provider', error))
]) assert.equal(shouldRetryProviderError(error), false)
assert.equal(retryMessageKey({ failedAttempt: 1, maxRetries: 5, reason: 'provider_busy' }), 'chat.providerBusy')
assert.equal(retryMessageKey({ failedAttempt: 1, maxRetries: 5 }), 'chat.retrying')

try {
  for (const first of [() => new Response('busy', { status: 429 }),
    () => new Response('busy: upstream diagnostic mentions invalid tool call arguments', { status: 429, headers: { 'retry-after': '0' } }),
    () => sseError({ code: 429, message: 'busy: failed to parse tool call arguments as json' }),
    () => sseError(rateError), () => sseError({ code: '429', message: 'busy' }),
    () => sseError({ type: 'rate_limit_error', message: 'try later' })]) {
    let attempts = 0, retries = 0, errors = 0
    const bodies: string[] = []
    globalThis.fetch = async (_url, init) => { bodies.push(String(init!.body)); return ++attempts === 1 ? first() : successful() }
    const result = await streamChat(provider, params, { onRetry: (attempt, max, error) => {
      retries++; assert.equal(attempt, 1); assert.equal(max, 1); assert.equal(isProviderBusyError(error), true)
    }, onError: () => { errors++ } })
    assert.equal(result.content, 'ready'); assert.equal(attempts, 2); assert.equal(retries, 1); assert.equal(errors, 0)
    assert.equal(bodies[0], bodies[1], 'retry sends the same current request without adding history')
  }
  for (const response of [() => new Response('validation failed', { status: 422 }),
    () => sseError({ code: '422', message: 'validation failed' })]) {
    let attempts = 0
    globalThis.fetch = async () => { attempts++; return response() }
    await assert.rejects(streamChat(provider, params, { onRetry: () => assert.fail('422 must not retry') }),
      /validation failed/)
    assert.equal(attempts, 1)
  }
  {
    let attempts = 0
    globalThis.fetch = async () => { attempts++; return new Response('validation failed', { status: 422 }) }
    await assert.rejects(complete(provider, params.messages), /422/)
    assert.equal(attempts, 1, 'non-streaming 422 is terminal too')
  }
  {
    let attempts = 0, retries = 0
    globalThis.fetch = async () => { attempts++; return sseError(rateError) }
    await assert.rejects(streamChat(provider, params, { onRetry: () => { retries++ } }), e => {
      assert.ok(e instanceof ProviderStreamError)
      assert.ok(e.message.includes(JSON.stringify(rateError, null, 2)), 'exhaustion keeps the full original error')
      return true
    })
    assert.equal(attempts, 2); assert.equal(retries, 1)
  }
  {
    let attempts = 0
    const abort = new AbortController()
    globalThis.fetch = async () => { attempts++; return sseError(rateError) }
    await assert.rejects(streamChat(provider, { ...params, signal: abort.signal }, { onRetry: () => abort.abort() }), { name: 'AbortError' })
    assert.equal(attempts, 1, 'abort during busy backoff never sends another request')
  }
  for (const delta of [{ content: 'partial' }, { reasoning: 'thinking' },
    { tool_calls: [{ index: 0, id: 'not-executed', function: { name: 'write', arguments: '{}' } }] }]) {
    let attempts = 0
    globalThis.fetch = async () => { attempts++; return new Response(frame(delta) + `data: ${JSON.stringify({ error: rateError })}\n\n`) }
    await assert.rejects(streamChat(provider, params, { onRetry: () => assert.fail('emitted output cannot be transparently replayed') }), ProviderStreamError)
    assert.equal(attempts, 1)
  }
  {
    let attempts = 0
    globalThis.fetch = async () => ++attempts === 1 ? new Response('busy', { status: 429 })
      : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'ready' } }] })
    assert.equal(await complete(provider, params.messages), 'ready'); assert.equal(attempts, 2)
  }
  {
    let attempts = 0
    globalThis.fetch = async () => ++attempts === 1
      ? Response.json({ error: { code: 429, message: 'busy: func_args_not_string from upstream' } })
      : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'ready' } }] })
    assert.equal(await complete(provider, params.messages), 'ready'); assert.equal(attempts, 2)
  }
  for (const maxRounds of [10, 1]) {
    const saved: UIMessage[] = []; const events: AgentRetryEvent[] = []
    let attempts = 0, tools = 0, completed = 0, id = 0
    const ipc = createIpcAgentEventSink({ send: (channel: string, event: AgentRetryEvent) => {
      if (channel === 'agent:retry') events.push(event)
    } } as Electron.WebContents)
    const callbacks = createPersistedAgentCallbacks('current-session', { addMessage: m => saved.push(m), addTokenUsage() {} },
      () => `m${++id}`, { ...ipc, complete: () => { completed++ } })
    const registry = new ToolRegistry()
    registry.register('write', { permission: 'normal', definition: { type: 'function', function: { name: 'write', description: '', parameters: {} } },
      execute: async () => { tools++; return { content: 'written' } } })
    globalThis.fetch = async () => ++attempts === 1
      ? new Response(frame({ tool_calls: [{ index: 0, id: 'written', function: { name: 'write', arguments: '{}' } }] }, 'tool_calls'))
      : attempts === 2 ? sseError(rateError) : successful()
    const running = runAgent({ provider, ...params, messageIds: ['u'], workspacePath: '', compaction: null,
      memoryEnabled: false, maxRounds, toolRegistry: registry, permissionCheck: async () => true }, callbacks)
    if (maxRounds === 1) await assert.rejects(running, { name: 'AgentCompletionError', reason: 'limit' })
    else await running
    assert.equal(tools, 1); assert.equal(attempts, 3); assert.equal(completed, maxRounds === 1 ? 0 : 1)
    assert.equal(saved.filter(m => m.role === 'tool').length, 1)
    assert.deepEqual(events, [{ sessionId: 'current-session', failedAttempt: 1, maxRetries: 1, reason: 'provider_busy' }],
      'ordinary and finalization retry notifications both cross the typed IPC boundary with the right session')
    ipc.retry?.('other-session', 2, 5, new Error('fetch failed'))
    assert.equal(events.at(-1)!.reason, 'network'); assert.equal(events.at(-1)!.sessionId, 'other-session')
  }
} finally { globalThis.fetch = originalFetch }
console.log('Provider busy: 429 retries, terminal 422, budgets, abort, no output replay, tool history and IPC hints passed')
