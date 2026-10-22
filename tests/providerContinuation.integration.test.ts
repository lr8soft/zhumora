import assert from 'node:assert/strict'
import { register } from 'node:module'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { createPersistedAgentCallbacks } from '../src/main/agent/persistedCallbacks.ts'
import { AgentAbortedError, type ChatMessage, type UIMessage } from '../src/shared/types.ts'
import { WorkingConversation } from '../src/main/agent/workingConversation.ts'

register('./helpers/providerBusyLoader.mjs', import.meta.url)
const { runAgent } = await import('../src/main/agent/runner.ts')
const { streamAgentRound } = await import('../src/main/agent/streamRound.ts')
const originalFetch = globalThis.fetch
const settings = globalThis as typeof globalThis & { __testMaxRetries?: number }
const provider = { id: 'continuation', name: 'fixture', baseUrl: 'https://fixture.invalid/v1',
  apiKey: '', defaultModel: 'fixture', enabled: true }
const frame = (delta: object, finish_reason: string | null = null) =>
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
const ended = (delta: object, finish = 'stop') => new Response(frame(delta) + frame({}, finish) + 'data: [DONE]\n\n')
const call = (id: string, args = '{}') => ({ tool_calls: [{ index: 0, id, type: 'function',
  function: { name: 'write', arguments: args } }] })
const busy = { code: 429, message: 'busy' }
const unknown = { message: 'openai_error', type: 'bad_response_status_code', code: 'bad_response_status_code', param: '' }
const interrupted = (delta: object, error: unknown = busy) => new Response(frame(delta)
  + 'data: ' + JSON.stringify({ error, trace: 'original-envelope' }) + '\n\n',
  { headers: { 'retry-after': '0', 'x-request-id': 'fixture-request' } })

function fixture(respond: (attempt: number, request: { messages: ChatMessage[] }) => Response) {
  const saved: UIMessage[] = []; const requests: { messages: ChatMessage[]; reasoning_effort?: string }[] = []
  const starts: string[] = []; const streamed = new Map<string, string>()
  let executed = 0; let completed = 0; let id = 0
  const cb = createPersistedAgentCallbacks('s', { addMessage: m => saved.push(m),
    updateMessageGeneration(messageId, generation) {
      const message = saved.find(m => m.id === messageId)
      if (message) message.generation = generation
    }, addTokenUsage() {} }, () => 'm' + ++id,
  { complete() { completed++ }, assistantStart: (_s, id) => starts.push(id),
    token(_s, id, token) { streamed.set(id, (streamed.get(id) ?? '') + token) } })
  const registry = new ToolRegistry()
  registry.register('write', { definition: { type: 'function', function: { name: 'write', description: '', parameters: {} } },
    permission: 'normal', execute: async () => { executed++; return { content: 'saved once' } } })
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request)
    return respond(requests.length, request)
  }
  async function run(signal?: AbortSignal, maxRounds = 20, reasoningEffort?: 'high') {
    try {
      return await runAgent({ provider, messages: [{ role: 'user', content: 'implement and validate' }],
        messageIds: ['u'], workspacePath: '', compaction: null, toolRegistry: registry, memoryEnabled: false,
        maxRounds, signal, reasoningEffort, permissionCheck: async () => true }, cb)
    } catch (error) {
      if (!(error instanceof AgentAbortedError)) cb.onError?.(error as Error)
      throw error
    }
  }
  return { run, cb, saved, requests, starts, streamed, count: () => ({ executed, completed }) }
}

try {
  settings.__testMaxRetries = 2
  for (const error of [busy, unknown]) {
    let retries = 0
    const f = fixture(attempt => attempt === 1 ? ended(call('completed-tool'), 'tool_calls')
      : attempt === 2 ? interrupted({ content: 'Work saved; ', reasoning_content: 'first attempt thought' }, error)
        : ended({ content: 'Validation complete.', reasoning_content: 'fresh thought' }))
    f.cb.onRetry = () => { retries++ }
    await f.run()
    assert.equal(retries, 1)
    assert.deepEqual(f.count(), { executed: 1, completed: 1 })
    const partial = f.saved.find(m => m.content === 'Work saved; ')!
    const final = f.saved.find(m => m.content === 'Validation complete.')!
    assert.ok(partial && final, 'preserve failed output independently from the recovered answer')
    assert.notEqual(partial.id, final.id)
    assert.equal(partial.generation?.status, 'incomplete')
    assert.equal(partial.generation?.providerError?.requestId, 'fixture-request')
    assert.equal(partial.generation?.providerError?.httpStatus, 200)
    assert.deepEqual(partial.generation?.providerError?.envelope, { error, trace: 'original-envelope' })
    assert.equal(partial.generation?.providerError?.category, error === busy ? 'rate_limit' : 'unknown')
    assert.equal(partial.reasoning, 'first attempt thought')
    assert.equal(final.reasoning, 'fresh thought', 'failed attempt reasoning must not leak into the new attempt')
    assert.equal(f.streamed.get(final.id), 'Validation complete.')
    assert.ok(f.starts.includes(final.id))
    assert.equal(f.saved.filter(m => m.role === 'tool').length, 1)
    const history = f.requests[2].messages
    const at = history.findIndex(m => m.tool_calls?.some(t => t.id === 'completed-tool'))
    assert.equal(history[at + 1].tool_call_id, 'completed-tool')
    assert.ok(history.some(m => m.role === 'assistant' && m.content === 'Work saved; '))
    assert.ok(!f.saved.some(m => m.status === 'error'), 'temporary provider failure must not become a permanent error message')
  }
  {
    const f = fixture(attempt => attempt === 1 ? ended(call('completed-tool'), 'tool_calls')
      : attempt === 2 ? interrupted(call('never-executed', '{')) : ended({ content: 'done' }))
    await f.run()
    assert.deepEqual(f.count(), { executed: 1, completed: 1 })
    assert.equal(f.saved.filter(m => m.toolCallId === 'never-executed').length, 1, 'close the rejected tool group')
    assert.equal(f.saved.find(m => m.toolCallId === 'never-executed')!.status, 'error')
    assert.ok(!JSON.stringify(f.requests[2].messages).includes('never-executed'), 'invalid partial arguments stay out of the effective history')
  }
  for (const error of [busy, unknown]) for (const limit of [0, 2, -1]) {
    settings.__testMaxRetries = limit
    const abort = new AbortController(); const retries: number[] = []
    const f = fixture(attempt => interrupted({ content: 'partial ' + attempt }, error))
    f.cb.onRetry = (attempt, maximum) => {
      assert.equal(maximum, limit); retries.push(attempt)
      if (limit === -1 && attempt === 5) abort.abort()
    }
    await assert.rejects(f.run(abort.signal), limit === -1 ? AgentAbortedError : { name: 'ProviderStreamError' })
    assert.equal(f.requests.length, limit === -1 ? 5 : limit + 1)
    assert.deepEqual(retries, limit === -1 ? [1, 2, 3, 4, 5] : limit === 0 ? [] : [1, 2])
    assert.equal(f.count().completed, 0)
    assert.equal(f.count().executed, 0)
    assert.equal(new Set(f.saved.map(m => m.id)).size, f.saved.length)
    if (limit !== -1) {
      assert.equal(f.saved.at(-1)!.generation?.purpose, 'agent')
      assert.equal(f.saved.at(-1)!.generation?.providerError?.category, error === busy ? 'rate_limit' : 'unknown')
    }
  }
  settings.__testMaxRetries = -1
  for (const limit of [0, 1]) {
    settings.__testMaxRetries = limit
    const f = fixture(attempt => interrupted(call('not-executed-' + attempt)))
    await assert.rejects(f.run(), { name: 'ProviderStreamError' })
    assert.equal(f.requests.length, limit + 1)
    assert.deepEqual(f.count(), { executed: 0, completed: 0 })
    for (let attempt = 1; attempt <= limit + 1; attempt++) {
      const assistantAt = f.saved.findIndex(m => m.toolCalls?.some(tc => tc.id === 'not-executed-' + attempt))
      assert.ok(assistantAt >= 0, 'preserve the last failed tool group even when there will be no retry')
      assert.equal(f.saved[assistantAt + 1].toolCallId, 'not-executed-' + attempt)
      assert.equal(f.saved[assistantAt + 1].status, 'error')
    }
    assert.ok(!JSON.stringify(f.requests.at(-1)!.messages).includes('not-executed-'))
  }
  settings.__testMaxRetries = 1
  {
    const f = fixture(attempt => attempt === 1 ? interrupted({ refusal: 'Provider refusal text' })
      : ended({ content: 'ready' }))
    await f.run()
    const refusal = f.saved.find(m => m.content === 'Provider refusal text')
    assert.ok(refusal, 'preserve actual refusal text from an interrupted attempt')
    assert.equal(refusal.generation?.status, 'incomplete')
    assert.equal(refusal.generation?.providerError?.category, 'rate_limit')
    assert.equal(f.requests.length, 2, 'explicit 429 still follows the configured retry policy')
  }
  settings.__testMaxRetries = -1
  {
    const f = fixture(() => interrupted({ content: 'partial' }))
    const failure = new Error('network persistence unavailable')
    let settlements = 0
    f.cb.onAssistantMessage = () => { settlements++; throw failure }
    await assert.rejects(f.run(), error => error === failure)
    assert.equal(settlements, 1, 'a failed settlement must not be mistaken for a second interrupted model round')
    assert.equal(f.requests.length, 1)
  }
  {
    const f = fixture(attempt => attempt <= 5 ? interrupted({}, unknown) : ended({ content: 'done' }))
    await f.run()
    assert.equal(f.requests.length, 6, 'unknown Provider errors use the configured unlimited transport policy')
    assert.equal(f.count().completed, 1)
  }
  {
    const f = fixture(attempt => attempt === 1 ? interrupted({ content: 'partial' })
      : attempt === 2 ? new Response('Unsupported parameter: reasoning_effort', { status: 400 }) : ended({ content: 'done' }))
    await f.run(undefined, 20, 'high')
    assert.equal(f.requests.length, 3)
    assert.equal(f.requests[1].reasoning_effort, 'high')
    assert.equal(f.requests[2].reasoning_effort, undefined, 'a failed previous attempt cannot prevent one request-local parameter downgrade')
    assert.equal(f.saved.filter(m => m.content === 'partial').length, 1)
  }
  {
    const abort = new AbortController()
    const f = fixture(() => interrupted({ content: 'partial' }))
    const persist = f.cb.onAssistantMessage
    f.cb.onAssistantMessage = (...args) => { const id = persist?.(...args); abort.abort(); return id ?? null }
    await assert.rejects(f.run(abort.signal), AgentAbortedError)
    assert.equal(f.requests.length, 1, 'cancellation while preserving output stops the next attempt')
    assert.equal(f.saved.filter(m => m.content === 'partial').length, 1)
    assert.ok(!f.saved.some(m => m.status === 'error'), 'cancellation stays cancellation')
  }
  {
    const f = fixture(attempt => attempt === 1 ? ended(call('done'), 'tool_calls')
      : attempt === 2 ? interrupted({ content: 'Progress: ' }) : ended({ content: 'Progress preserved.' }))
    await assert.rejects(f.run(undefined, 1), { name: 'AgentCompletionError', reason: 'limit' })
    assert.equal(f.requests.length, 3)
    assert.deepEqual(f.count(), { executed: 1, completed: 0 })
    assert.equal(f.saved.filter(m => m.role === 'tool').length, 1)
  }
  for (const moment of ['exhausted', 'tool-result', 'prepare'] as const) {
    settings.__testMaxRetries = moment === 'exhausted' ? 0 : -1
    const abort = new AbortController()
    const delta = call('first')
    delta.tool_calls.push({ ...call('second').tool_calls[0], index: 1 })
    const f = fixture(() => interrupted(delta))
    const conversation = new WorkingConversation('system')
    conversation.append({ role: 'user', content: 'work' }, 'u')
    let results = 0; let preparations = 0
    const onResult = f.cb.onToolResult
    f.cb.onToolResult = (...args) => {
      const id = onResult?.(...args)
      if (++results === 1 && moment === 'tool-result') abort.abort()
      return id ?? null
    }
    await assert.rejects(streamAgentRound(conversation, provider, undefined, undefined, [], abort.signal, f.cb, [], async () => {
      preparations++
      await Promise.resolve()
      if (moment === 'prepare') abort.abort()
    }), moment === 'exhausted' ? { name: 'ProviderStreamError' } : AgentAbortedError)
    assert.equal(f.requests.length, 1)
    assert.equal(preparations, moment === 'prepare' ? 1 : 0, 'terminal failure or cancelled settlement cannot prepare another attempt')
    assert.deepEqual(f.saved.filter(m => m.role === 'tool').map(m => m.toolCallId), ['first', 'second'],
      'cancellation must still close the entire unexecuted tool group')
    assert.equal(conversation.messages.length, moment === 'prepare' ? 3 : 2)
    assert.equal(conversation.messages.length, conversation.ids.length)
    assert.ok(!conversation.messages.some(m => m.tool_calls?.length), 'failed tool groups never enter the effective history')
    assert.equal(f.count().executed, 0)
  }
} finally { globalThis.fetch = originalFetch; delete settings.__testMaxRetries }
console.log('Provider continuation: configured retries, independent messages, cancellation, tools and finalization passed')
