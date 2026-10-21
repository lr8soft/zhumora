import assert from 'node:assert/strict'
import { register } from 'node:module'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { createPersistedAgentCallbacks } from '../src/main/agent/persistedCallbacks.ts'
import { AgentAbortedError, type UIMessage, type ChatMessage } from '../src/shared/types.ts'
import { buildCompletionReviewInput } from '../src/main/agent/completionReviewInput.ts'
import { assertContextFits } from '../src/main/agent/contextBudget.ts'
import { isProviderBusyError } from '../src/main/llm/providerRetry.ts'
register('./helpers/providerBusyLoader.mjs', import.meta.url)
const { runAgent } = await import('../src/main/agent/runner.ts')
const originalFetch = globalThis.fetch
const provider = { completionReview: true, id: 'guard', name: 'guard', baseUrl: 'https://fixture.invalid/v1',
  apiKey: '', defaultModel: 'fixture', enabled: true }
const frame = (delta: object, finish_reason: string | null = null) =>
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
const ended = (delta: object, finish = 'stop') => new Response(frame(delta) + frame({}, finish) + 'data: [DONE]\n\n')
const tool = { tool_calls: [{ index: 0, id: 'write-once', type: 'function',
  function: { name: 'write', arguments: '{}' } }] }
type Request = { messages: ChatMessage[]; tools?: unknown[]; stream?: boolean; reasoning_effort?: string;
  max_tokens?: number; max_completion_tokens?: number }
function fixture(reviews: string[], options: { abort?: AbortController; reviewError?: boolean; reviewTool?: boolean; guidance?: boolean;
  signal?: AbortSignal; reasoningEffort?: 'high'; outputTokenParameter?: 'max_completion_tokens';
  respond?: (request: Request, review: boolean) => Response | undefined } = {}) {
  const saved: UIMessage[] = []; const requests: { messages: ChatMessage[]; tools?: unknown[]; stream?: boolean }[] = []
  let normal = 0; let reviewed = 0; let executed = 0; let completed = 0; let id = 0; let streamed = ''
  let pendingGuidance = false
  const cb = createPersistedAgentCallbacks('s', { addMessage: m => saved.push(m), addTokenUsage() {} },
    () => 'm' + ++id, { complete: () => { completed++ }, token: (_s, _id, text) => { streamed += text } })
  const registry = new ToolRegistry()
  registry.register('write', { definition: { type: 'function', function: { name: 'write', description: '', parameters: {} } },
    permission: 'normal', execute: async () => { executed++; return { content: 'saved' } } })
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string); requests.push(request)
    const isReview = String(request.messages[0]?.content).startsWith('[Completion review]')
    const override = options.respond?.(request, isReview)
    if (override) return override
    if (isReview) {
      reviewed++
      options.abort?.abort()
      if (options.reviewError) return new Response('review unavailable', { status: 503 })
      if (options.reviewTool) return ended(tool, 'tool_calls')
      return ended({ content: reviews[Math.min(reviewed - 1, reviews.length - 1)] })
    }
    normal++
    if (normal === 2 && options.guidance) pendingGuidance = true
    return normal === 1 ? ended(tool, 'tool_calls')
      : ended({ content: normal === 2 ? '继续分析实现策略（cl' : 'Implementation and validation are complete.' })
  }
  const run = async (maxRounds = 20) => {
    try {
      return await runAgent({ provider: { ...provider, outputTokenParameter: options.outputTokenParameter },
        reasoningEffort: options.reasoningEffort, messages: [{ role: 'user', content: 'implement and validate' }], messageIds: ['u'],
        workspacePath: '', compaction: null, toolRegistry: registry, memoryEnabled: false, maxRounds,
        signal: options.signal ?? options.abort?.signal, permissionCheck: async () => true,
        takeCoordinationMessages: finalizing => {
          if (!finalizing || !pendingGuidance) return []
          assert.equal(saved.at(-1)!.content, '继续分析实现策略（cl', 'persist assistant before incoming guidance')
          pendingGuidance = false
          return [{ id: 'guidance', message: { role: 'user', content: 'New parent evidence' } }]
        } }, cb)
    } catch (error) { if (!(error instanceof AgentAbortedError)) cb.onError?.(error as Error); throw error }
  }
  return { run, cb, saved, requests, count: () => ({ normal, reviewed, executed, completed, streamed }) }
}
const verdict = (decision: string) => JSON.stringify({ decision, reason: decision === 'continue' ? 'Candidate ends in unfinished speech' : 'Complete final delivery' })
try {
  {
    const f = fixture([verdict('continue'), verdict('final')])
    await f.run()
    assert.deepEqual({ ...f.count(), streamed: '' }, { normal: 3, reviewed: 2, executed: 1, completed: 1, streamed: '' })
    assert.ok(!f.count().streamed.includes('decision'), 'control output must never stream as an assistant reply')
    assert.equal(f.saved.find(m => m.content.includes('（cl'))!.generation?.status, 'unverified')
    assert.equal(f.saved.at(-1)!.generation?.status, 'complete')
    const lastNormal = f.requests.filter(r => r.tools).at(-1)!
    assert.equal(lastNormal.messages.filter(m => m.role === 'tool').length, 1)
    assert.ok(lastNormal.messages.some(m => m.role === 'user' && String(m.content).includes('Completion review found')))
    assert.equal(f.saved.filter(m => m.role === 'tool').length, 1)
    assert.equal(new Set(f.saved.map(m => m.id)).size, f.saved.length, 'assessment updates never insert a duplicate assistant')
    assert.equal(f.saved.at(-1)!.generation?.assessmentRevision, 1)
  }
  {
    const f = fixture([verdict('final')], { guidance: true })
    await f.run()
    assert.equal(f.count().reviewed, 1, 'queued guidance precedes the bounded review')
    assert.equal(f.count().normal, 3); assert.equal(f.count().executed, 1)
    assert.equal(f.saved.find(m => m.content.includes('（cl'))!.generation?.status, 'unverified')
    assert.ok(f.saved.every(m => m.generation?.status !== 'checking'), 'superseded candidates must not stay checking')
  }
  for (const review of [verdict('continue'), verdict('uncertain'), 'not JSON']) {
    const f = fixture([review])
    await assert.rejects(f.run(0), { name: 'AgentCompletionError', reason: 'unverified' })
    assert.ok(f.count().reviewed <= 2); assert.ok(f.count().normal <= 3)
    assert.equal(f.count().executed, 1); assert.equal(f.count().completed, 0)
    assert.equal(f.saved.at(-1)!.status, 'error')
  }
  for (const options of [{ reviewError: true }, { reviewTool: true }]) {
    const f = fixture([], options)
    await assert.rejects(f.run(), { name: 'AgentCompletionError', reason: 'unverified' })
    assert.equal(f.count().reviewed, 1, 'non-busy review failures do not retry')
    assert.equal(f.count().executed, 1); assert.equal(f.count().completed, 0)
    if (options.reviewError) assert.match(f.saved.at(-1)!.content, /review unavailable/)
  }
  {
    const abort = new AbortController(); const f = fixture([verdict('final')], { abort })
    await assert.rejects(f.run(), AgentAbortedError)
    assert.equal(f.count().executed, 1); assert.equal(f.count().completed, 0)
    assert.equal(f.saved.at(-1)!.generation?.status, 'unverified')
  }
  {
    const abort = new AbortController(); const f = fixture([verdict('final')], { signal: abort.signal })
    const publish = f.cb.onAssistantGeneration
    f.cb.onAssistantGeneration = (id, generation) => {
      publish?.(id, generation)
      if (generation.status === 'complete') abort.abort()
    }
    await assert.rejects(f.run(), AgentAbortedError)
    assert.equal(f.count().completed, 0); assert.equal(f.count().executed, 1)
    assert.equal(f.saved.at(-1)!.generation?.status, 'unverified')
  }
  {
    let reviews = 0; let retries = 0
    const f = fixture([verdict('final')], { reasoningEffort: 'high', respond(request, review) {
      if (!review) return
      reviews++
      if (reviews === 1) return new Response(frame({ reasoning_content: 'discard this attempt' })
        + 'data: {"error":{"code":429,"message":"busy"}}\n\n', { headers: { 'retry-after': '0' } })
      if (request.reasoning_effort) return new Response('Unsupported parameter: reasoning_effort', { status: 400 })
    } })
    f.cb.onRetry = () => { retries++ }
    await f.run()
    assert.equal(reviews, 3); assert.equal(retries, 1)
    assert.equal(f.count().completed, 1); assert.equal(f.count().executed, 1)
    assert.doesNotMatch(JSON.stringify(f.saved), /discard this attempt/)
  }
  {
    const f = fixture([])
    await assert.rejects(f.run(1), { name: 'AgentCompletionError', reason: 'limit' })
    assert.equal(f.count().reviewed, 0); assert.equal(f.count().executed, 1); assert.equal(f.count().completed, 0)
    assert.ok(f.saved.some(m => m.generation?.status === 'limit'))
  }
  {
    let rejected = 0
    const f = fixture([verdict('final')], { reasoningEffort: 'high', respond(request, review) {
      if (review) assert.equal(request.reasoning_effort, undefined, 'review inherits candidate compatibility downgrade')
      if (request.reasoning_effort) { rejected++; return new Response('Unsupported parameter: reasoning_effort', { status: 400 }) }
    } })
    await f.run()
    assert.equal(rejected, 2); assert.equal(f.count().completed, 1); assert.equal(f.count().executed, 1)
  }
  {
    const f = fixture([verdict('final')], { outputTokenParameter: 'max_completion_tokens', respond(request, review) {
      assert.equal(request.max_tokens, undefined)
      if (review) assert.equal(request.max_completion_tokens, 4096)
    } })
    await f.run()
    assert.equal(f.count().completed, 1); assert.equal(f.count().executed, 1)
  }
  // Busy retries use exactly the user's setting, independently of the semantic review budget.
  for (const transport of ['http', 'sse'] as const) for (const limit of [0, 2, -1]) for (const recover of [false, true]) {
    const settings = globalThis as typeof globalThis & { __testMaxRetries?: number }
    settings.__testMaxRetries = limit
    const abort = new AbortController(); let attempts = 0; let retries = 0
    const f = fixture([verdict('final')], { signal: abort.signal, respond(_request, review) {
      if (!review) return
      attempts++
      const busyCount = limit === -1 ? 4 : limit
      if (!recover || attempts <= busyCount) return transport === 'http'
        ? new Response('provider busy detail', { status: 429, headers: { 'retry-after': '0' } })
        : new Response(frame({ reasoning_content: 'private control thought', content: '{"decision":' })
          + 'data: {"error":{"code":429,"message":"provider busy detail"}}\n\n', { headers: { 'retry-after': '0' } })
    } })
    f.cb.onRetry = (_failed, maximum, error) => {
      retries++; assert.equal(maximum, limit); assert.equal(isProviderBusyError(error), true)
      if (!recover && limit === -1 && retries === 4) abort.abort()
    }
    try {
      if (recover) { await f.run(); assert.equal(f.count().completed, 1) }
      else {
        await assert.rejects(f.run(), limit === -1 ? AgentAbortedError : { name: 'AgentCompletionError', reason: 'unverified' })
        assert.equal(f.count().completed, 0)
        if (limit !== -1) assert.match(f.saved.at(-1)!.content, /provider busy detail/)
      }
      assert.equal(retries, limit === -1 ? 4 : limit)
      assert.equal(attempts, recover ? retries + 1 : limit === -1 ? 4 : limit + 1)
      assert.equal(f.count().executed, 1, 'retrying review never replays completed tools')
      assert.equal(f.saved.filter(m => m.role === 'tool').length, 1)
      assert.doesNotMatch(f.count().streamed, /private control thought|decision/)
    } finally { delete settings.__testMaxRetries }
  }
  {
    const goal = '核'.repeat(2500); const candidate = '答'.repeat(1000)
    const history: ChatMessage[] = [{ role: 'system', content: 'rules '.repeat(800) },
      { role: 'user', content: goal }, { role: 'tool', content: '果'.repeat(500), tool_call_id: 'done' },
      { role: 'assistant', content: candidate }]
    assertContextFits(history, 8192)
    const request = buildCompletionReviewInput(goal, candidate, history, 8192)
    assertContextFits(request.messages, 8192, [], request.maxTokens)
    const evidence = JSON.parse(String(request.messages[1].content))
    assert.equal(evidence.goal, goal); assert.equal(evidence.candidate, candidate)
    assert.deepEqual(evidence.recentInputs, [], 'do not spend context on a duplicate goal')
    const snapshot = JSON.stringify(history)
    for (const window of [4096, 8192, 16384]) {
      const large = buildCompletionReviewInput(goal.repeat(8), candidate.repeat(32), history, window)
      assertContextFits(large.messages, window, [], large.maxTokens)
      assert.match(String(large.messages[1].content), /omitted/)
    }
    assert.equal(JSON.stringify(history), snapshot, 'review projection cannot mutate history')
    const image = buildCompletionReviewInput('look', 'done', [{ role: 'user', content: [
      { type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,PRIVATE_IMAGE' } }
    ] }], 8192)
    assert.doesNotMatch(JSON.stringify(image), /PRIVATE_IMAGE/)
    assert.match(JSON.stringify(image), /image\(s\) omitted/)
  }
} finally { globalThis.fetch = originalFetch }
console.log('Completion guard: half replies, bounded review/continuation, no tool replay, abort and limit propagation passed')
