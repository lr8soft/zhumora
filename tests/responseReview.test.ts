import assert from 'node:assert/strict'
import { register } from 'node:module'
import type { UIMessage, ChatMessage } from '../src/shared/types.ts'
import { AgentAbortedError } from '../src/shared/types.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { createPersistedAgentCallbacks } from '../src/main/agent/persistedCallbacks.ts'
import { createStreamAccumulator } from '../src/main/llm/sseAccumulator.ts'
import { readChatStream } from '../src/main/llm/streamResponse.ts'
import { ProviderStreamError } from '../src/main/llm/streamErrors.ts'
import { WorkingConversation } from '../src/main/agent/workingConversation.ts'
import { completeTurn } from '../src/main/agent/completeTurn.ts'
import { hasValidToolCalls } from '../src/shared/toolCalls.ts'
import { sanitizeHistoryWithIds } from '../src/main/agent/history.ts'

register('./helpers/runnerCollaborationLoader.mjs', import.meta.url)
const { runAgent } = await import('../src/main/agent/runner.ts')
const previousFetch = globalThis.fetch
const provider = { id: 'review', name: 'review', baseUrl: 'https://fixture.invalid/v1', apiKey: '', defaultModel: 'test', enabled: true }
const frame = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const ended = (delta: object, finish = 'stop') => new Response(frame(delta) + frame({}, finish) + 'data: [DONE]\n\n')
const tool = (id: string, index = 0) => ({ index, id, type: 'function' as const, function: { name: 'write', arguments: '{}' } })

function fixture() {
  const saved: UIMessage[] = []; const requests: { messages: ChatMessage[]; tools?: unknown[] }[] = []
  let id = 0; let complete = 0; let executed = 0
  const cb = createPersistedAgentCallbacks('session', { addMessage: m => saved.push(m), addTokenUsage() {} },
    () => `r${++id}`, { complete: () => { complete++ } })
  const registry = new ToolRegistry()
  registry.register('write', { definition: { type: 'function', function: { name: 'write', description: 'write', parameters: {} } },
    permission: 'normal', execute: async () => { executed++; return { content: 'saved' } } })
  const options = { provider, workspacePath: '', messages: [{ role: 'user' as const, content: 'work' }],
    messageIds: ['u'], compaction: null, memoryEnabled: false, maxRounds: 10, toolRegistry: registry, permissionCheck: async () => true }
  const fetches = (next: (request: typeof requests[number], index: number) => Response) => {
    globalThis.fetch = async (_url, init) => { const request = JSON.parse(init!.body as string); requests.push(request); return next(request, requests.length) }
  }
  return { saved, requests, cb, options, fetches, complete: () => complete, executed: () => executed }
}

async function beforeDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('stream cleanup blocked completion')), 200)
  })]) } finally { clearTimeout(timer) }
}

try {
  {
    let cancelled = false
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ content: 'done' }, 'stop') + 'data: [DONE]\n\n'))
    }, cancel() { cancelled = true; return new Promise<void>(() => {}) } }))
    const acc = createStreamAccumulator()
    await beforeDeadline(readChatStream(response, acc, () => {}, () => {}))
    assert.equal(cancelled, true); assert.equal(response.body!.locked, false)
    assert.equal(acc.content, 'done')
  }
  {
    const acc = createStreamAccumulator()
    const response = new Response('data: {"choices": [\n' + 'data: {"delta": {"content":"multi line"},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n')
    await readChatStream(response, acc, () => {}, () => {})
    assert.equal(acc.content, 'multi line')
  }
  for (const choices of [[{ index: 1, delta: { content: 'wrong choice' }, finish_reason: 'stop' }],
    [{ index: 0, delta: {}, finish_reason: 'stop' }, { index: 1, delta: {}, finish_reason: 'stop' }]]) {
    await assert.rejects(readChatStream(new Response(`data: ${JSON.stringify({ choices })}\n\n`),
      createStreamAccumulator(), () => {}, () => {}), ProviderStreamError)
  }
  for (const first of ['text', 'reasoning'] as const) {
    const f = fixture()
    f.cb.onAssistantMessage?.('previous output', [], 'previous reasoning')
    if (first === 'reasoning') f.cb.onReasoningToken?.('current reasoning')
    f.cb.onToken?.('current partial')
    f.cb.onError?.(new Error('current failure'))
    assert.match(f.saved[1].content, /^current partial\n/)
    assert.doesNotMatch(f.saved[1].content, /previous/)
    assert.equal(f.saved[0].content, 'previous output')
  }
  {
    const f = fixture(); const abort = new AbortController()
    f.fetches((_request, i) => {
      if (i === 1) return ended({ tool_calls: [tool('written')] }, 'tool_calls')
      abort.abort(); return ended({ content: 'partial summary', reasoning_content: 'partial thought' })
    })
    await assert.rejects(runAgent({ ...f.options, maxRounds: 1, signal: abort.signal }, f.cb), AgentAbortedError)
    assert.ok(f.saved.some(m => m.content === 'partial summary' && m.reasoning === 'partial thought'))
    assert.equal(f.executed(), 1); assert.equal(f.complete(), 0)
  }
  {
    const f = fixture()
    f.fetches((request, i) => {
      if (!request.tools) return ended({ content: 'hard stop summary' })
      if (i > 2) throw new Error('ordinary tool generation continued after hard stop')
      return ended({ tool_calls: i === 1 ? [tool('one')] : [tool('two'), tool('three', 1)] }, 'tool_calls')
    })
    await runAgent({ ...f.options, maxRounds: 0, loopConfig: { softThreshold: 1, hardThreshold: 2 } }, f.cb)
    assert.equal(f.requests.length, 3); assert.equal(f.requests[2].tools, undefined)
    assert.equal(f.executed(), 1); assert.equal(f.complete(), 1)
    const results = f.saved.filter(m => m.role === 'tool')
    assert.deepEqual(results.map(m => m.toolCallId), ['one', 'two', 'three'])
    assert.ok(results.slice(1).every(m => m.status === 'error'))
  }
  {
    const call = tool('same')
    assert.equal(hasValidToolCalls({ role: 'assistant', content: null, tool_calls: [call, call] }), false)
    const raw: ChatMessage[] = [{ role: 'assistant', content: null, tool_calls: [call, call] },
      { role: 'tool', tool_call_id: 'same', content: 'not executed' },
      { role: 'tool', tool_call_id: 'same', content: 'not executed' }, { role: 'user', content: 'continue' }]
    const clean = sanitizeHistoryWithIds(raw, ['a', 't1', 't2', 'u'])
    assert.deepEqual(clean.messages, [raw[3]]); assert.deepEqual(clean.ids, ['u'])
  }
  {
    const f = fixture(); f.fetches((_request, i) => i === 1
      ? ended({ tool_calls: [tool('duplicate'), tool('duplicate', 1)] }, 'tool_calls') : ended({ content: 'recovered' }))
    await runAgent(f.options, f.cb)
    assert.equal(f.executed(), 0); assert.equal(f.complete(), 1)
    assert.ok(f.requests[1].messages.every(m => !m.tool_calls?.length))
    assert.equal(f.saved.filter(m => m.role === 'tool').length, 2)
  }
  {
    const conversation = new WorkingConversation('system'); const all: ChatMessage[] = []
    completeTurn({ content: 'final', reasoning: '', toolCalls: [], finishReason: 'stop', usage: undefined }, 1,
      { conversation, allAssistantMessages: all, cb: { onAssistantMessage: () => 'authoritative' } })
    assert.equal(all.at(-1)!.content, 'final'); assert.equal(conversation.ids.at(-1), 'authoritative')
    assert.equal(conversation.messages.length, conversation.ids.length)
  }
} finally { globalThis.fetch = previousFetch }
console.log('Response review: nonblocking cleanup, SSE events, round isolation, cancellation, hard stop and atomic history passed')
