import assert from 'node:assert/strict'
import { register } from 'node:module'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { createPersistedAgentCallbacks } from '../src/main/agent/persistedCallbacks.ts'
import { AgentAbortedError, type UIMessage, type ChatMessage } from '../src/shared/types.ts'
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
function fixture(reviews: string[], options: { abort?: AbortController; reviewError?: boolean; reviewTool?: boolean; guidance?: boolean } = {}) {
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
    if (String(request.messages[0]?.content).startsWith('[Completion review]')) {
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
      return await runAgent({ provider, messages: [{ role: 'user', content: 'implement and validate' }], messageIds: ['u'],
        workspacePath: '', compaction: null, toolRegistry: registry, memoryEnabled: false, maxRounds,
        signal: options.abort?.signal, permissionCheck: async () => true,
        takeCoordinationMessages: finalizing => {
          if (!finalizing || !pendingGuidance) return []
          assert.equal(saved.at(-1)!.content, '继续分析实现策略（cl', 'persist assistant before incoming guidance')
          pendingGuidance = false
          return [{ id: 'guidance', message: { role: 'user', content: 'New parent evidence' } }]
        } }, cb)
    } catch (error) { if (!(error instanceof AgentAbortedError)) cb.onError?.(error as Error); throw error }
  }
  return { run, saved, requests, count: () => ({ normal, reviewed, executed, completed, streamed }) }
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
    assert.equal(f.count().reviewed, 1, 'review has exactly one HTTP attempt even when network retries are enabled')
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
    const f = fixture([])
    await assert.rejects(f.run(1), { name: 'AgentCompletionError', reason: 'limit' })
    assert.equal(f.count().reviewed, 0); assert.equal(f.count().executed, 1); assert.equal(f.count().completed, 0)
    assert.ok(f.saved.some(m => m.generation?.status === 'limit'))
  }
} finally { globalThis.fetch = originalFetch }
console.log('Completion guard: half replies, bounded review/continuation, no tool replay, abort and limit propagation passed')
