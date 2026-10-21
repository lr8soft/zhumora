import assert from 'node:assert/strict'
import { register } from 'node:module'
import { createStreamAccumulator, applySseData } from '../src/main/llm/sseAccumulator.ts'
import { readChatStream } from '../src/main/llm/streamResponse.ts'
import { SseEventBuffer } from '../src/main/llm/sseEventBuffer.ts'
import { SseLineBuffer } from '../src/main/llm/sseAccumulator.ts'
import { ProviderStreamError } from '../src/main/llm/streamErrors.ts'
import { outputTokenLimit } from '../src/main/llm/responseParsing.ts'
register('./helpers/runnerCollaborationLoader.mjs', import.meta.url)
const { streamChat, complete } = await import('../src/main/llm/provider.ts')
const originalFetch = globalThis.fetch
const provider = { id: 'contract', name: 'contract', baseUrl: 'https://fixture.invalid/v1', apiKey: '', defaultModel: 'model', enabled: true }
const frame = (delta: object, finish_reason: string | null = null, extra = {}) =>
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...extra }) + '\n\n'
const end = frame({}, 'stop') + 'data: [DONE]\n\n'
const call = (id = 'a', index: unknown = 0, type = 'function') =>
  ({ tool_calls: [{ index, id, type, function: { name: 'write', arguments: '{}' } }] })
try {
  assert.equal(applySseData(createStreamAccumulator(), JSON.stringify({ choices: [{ delta: { tool_calls: [] } }] })).emitted, false)
  {
    const acc = createStreamAccumulator()
    const apply = (fragment: object) => applySseData(acc, JSON.stringify({ choices: [{ delta: { tool_calls: [fragment] } }] })).emitted
    assert.equal(apply({ index: 0 }), false)
    assert.equal(apply({ index: 0, id: '', function: { name: '', arguments: '' } }), false)
    assert.equal(apply({ index: 0, id: 'one', type: 'function' }), true)
    assert.equal(apply({ index: 0, id: 'one', type: 'function' }), false)
    assert.equal(apply({ index: 0, function: { name: 'write' } }), true)
    assert.equal(apply({ index: 0, function: { arguments: '{}' } }), true)
    assert.equal(acc.toolCalls.get(0)!.function.arguments, '{}')
  }
  for (const delta of [call('a', -1), call('a', 0.5), call('a', '0'), call('a', 0, 'custom'),
    { function_call: { name: 'write', arguments: '{}' } }, { audio: { data: 'unsupported output' } }, { tool_calls: [null] }]) {
    assert.throws(() => applySseData(createStreamAccumulator(), JSON.stringify({ choices: [{ delta }] })),
      { name: 'ProviderStreamError' })
  }
  {
    const acc = createStreamAccumulator()
    applySseData(acc, JSON.stringify({ choices: [{ delta: call() }] }))
    assert.throws(() => applySseData(acc, JSON.stringify({ choices: [{ delta: call('different') }] })), /identity|payload/)
  }
  {
    const acc = createStreamAccumulator()
    applySseData(acc, JSON.stringify({ id: 'first', choices: [{ delta: { content: 'a' } }] }))
    assert.throws(() => applySseData(acc, JSON.stringify({ id: 'second', choices: [{ delta: { content: 'b' } }] })), /identity|payload/)
  }
  for (const delimiter of ['\n', '\r\n', '\r']) {
    const body = (frame({ content: '完整 🧪' }) + end).replaceAll('\n', delimiter)
    for (const size of [1, 7]) {
      const bytes = new TextEncoder().encode(body); let at = 0
      const acc = createStreamAccumulator()
      await readChatStream(new Response(new ReadableStream({ pull(c) {
        if (at >= bytes.length) c.close()
        else { c.enqueue(bytes.slice(at, at + size)); at += size }
      } })), acc, () => {}, () => {})
      assert.equal(acc.content, '完整 🧪'); assert.equal(acc.finishReason, 'stop')
    }
  }
  globalThis.fetch = async () => new Response(frame({ refusal: 'Provider declined this request' }) + end)
  assert.equal((await streamChat(provider, { messages: [] })).refusal, 'Provider declined this request')
  globalThis.fetch = async () => new Response(frame({}, 'insufficient_system_resource') + 'data: [DONE]\n\n')
  await assert.rejects(streamChat(provider, { messages: [], maxRetries: 0 }), (error: unknown) => {
    const value = error as Error & { status: number; generation: { status: string } }
    assert.equal(value.status, 529); assert.equal(value.generation.status, 'incomplete'); return true
  })
  for (const payload of [{ error: { code: 429, message: 'original busy details' } },
    { choices: [{ message: { content: 'legacy', function_call: { name: 'write', arguments: '{}' } }, finish_reason: 'stop' }] },
    { choices: [{ index: 1, message: { content: 'wrong choice' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] },
    { choices: [{ message: { content: null, refusal: 'declined' }, finish_reason: 'stop' }] }]) {
    globalThis.fetch = async () => Response.json(payload)
    await assert.rejects(complete(provider, []))
  }
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init!.body as string).model, provider.defaultModel)
    return Response.json({ choices: [{ message: { content: 'valid title' }, finish_reason: 'stop' }] })
  }
  assert.equal(await complete(provider, [], ''), 'valid title', 'empty model override keeps the existing default-model behavior')
  {
    const official = { ...provider, baseUrl: 'https://api.openai.com/v1', defaultModel: 'o3' }
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      assert.equal(body.max_completion_tokens, 4096); assert.equal(body.max_tokens, undefined)
      return body.stream ? new Response(frame({ content: 'complete' }) + end)
        : Response.json({ choices: [{ message: { content: 'complete' }, finish_reason: 'stop' }] })
    }
    assert.equal((await streamChat(official, { messages: [], maxTokens: 4096 })).content, 'complete')
    assert.equal(await complete(official, [], undefined, 4096), 'complete')
    const proxy = { ...provider, defaultModel: 'upstream-alias', outputTokenParameter: 'max_completion_tokens' as const }
    assert.equal((await streamChat(proxy, { messages: [], maxTokens: 4096 })).content, 'complete')
    assert.equal(await complete(proxy, [], undefined, 4096), 'complete')
    assert.deepEqual(outputTokenLimit(provider, 800), { max_tokens: 800 })
    assert.deepEqual(outputTokenLimit({ ...official, outputTokenParameter: 'max_tokens' }, 800), { max_tokens: 800 })
  }
  for (const mime of [undefined, 'text/plain', 'text/event-stream', 'application/json']) for (const size of [1, 4096]) {
    const rawError = { code: 429, message: '原始繁忙详情', metadata: { raw: 'unmodified evidence' } }
    const body = new TextEncoder().encode(' \n' + JSON.stringify({ error: rawError }))
    let position = 0
    const response = new Response(new ReadableStream({ pull(controller) {
      if (position === body.length) { controller.close(); return }
      controller.enqueue(body.slice(position, position + size)); position = Math.min(body.length, position + size)
    } }), { headers: { ...(mime ? { 'content-type': mime } : {}), 'retry-after': '0' } })
    await assert.rejects(readChatStream(response, createStreamAccumulator(), () => {}, () => {}), (error: unknown) => {
      assert.ok(error instanceof ProviderStreamError)
      assert.equal(error.status, 429); assert.equal(error.retryAfterMs, 0)
      assert.match(error.message, /原始繁忙详情/); assert.match(error.message, /unmodified evidence/)
      return true
    })
    assert.equal(response.body!.locked, false)
  }
  {
    let attempts = 0; let retries = 0
    globalThis.fetch = async () => ++attempts === 1
      ? new Response(JSON.stringify({ error: { code: 429, message: 'busy from plain JSON' } }), { headers: { 'retry-after': '0' } })
      : new Response(frame({ content: 'recovered' }) + end)
    const result = await streamChat(provider, { messages: [], maxRetries: 1 }, { onRetry: () => { retries++ } })
    assert.equal(result.content, 'recovered'); assert.equal(attempts, 2); assert.equal(retries, 1)
  }
  for (const mime of [undefined, 'text/plain']) {
    const acc = createStreamAccumulator()
    await readChatStream(new Response(new TextEncoder().encode('\n: heartbeat\n\n' + frame({ content: 'valid SSE' }) + end),
      { headers: mime ? { 'content-type': mime } : {} }), acc, () => {}, () => {})
    assert.equal(acc.content, 'valid SSE', 'MIME compatibility must keep legal SSE working')
  }
  {
    let attempts = 0
    globalThis.fetch = async () => {
      attempts++
      return new Response(frame({ content: 'already visible' }) + 'data: {"error":{"code":429,"message":"busy after output"}}\n\n')
    }
    await assert.rejects(streamChat(provider, { messages: [], maxRetries: -1 }), /busy after output/)
    assert.equal(attempts, 1, 'ordinary user-visible output must not be transparently replayed')
  }
  globalThis.fetch = async () => new Response('x'.repeat(700) + 'actual-tail', { status: 422 })
  await assert.rejects(streamChat(provider, { messages: [] }), /actual-tail/)
  {
    let cancelled = false
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true } }))
    await assert.rejects(streamChat(provider, { messages: [], requestTimeoutMs: 10, maxRetries: 0 }), /request timeout/)
    assert.equal(cancelled, true, 'the absolute deadline also interrupts a pending reader')
  }
  {
    let attempts = 0
    globalThis.fetch = async (_url, init) => {
      attempts++
      const body = JSON.parse(init!.body as string)
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
      return new Response('Unsupported parameter chat_template_kwargs', { status: 422 })
    }
    await assert.rejects(streamChat(provider, { messages: [], model: 'Qwen3.8-27B', reasoningEffort: 'none' }), /422/)
    assert.equal(attempts, 1, 'explicit reasoning off cannot silently downgrade to default thinking')
  }
  let reads = 0
  globalThis.fetch = async () => new Response(new ReadableStream({ pull(c) {
    if (reads++ === 0) c.enqueue(new TextEncoder().encode(frame({ content: 'complete' }) + frame({}, 'stop')))
    else c.error(new Error('socket closed'))
  } }))
  const tail = await streamChat(provider, { messages: [] })
  assert.equal(tail.content, 'complete'); assert.notEqual(tail.streamInterrupted, true)
  assert.throws(() => new SseLineBuffer(8).feed('123456789', () => {}), /SSE line exceeds/)
  const event = new SseEventBuffer(20)
  event.feed('data: 123456789\n', () => {})
  assert.throws(() => event.feed('data: 1234567890\n', () => {}), /SSE event exceeds/)
  {
    const acc = createStreamAccumulator()
    await readChatStream(new Response(frame({ content: 'answer' }, null, { model: 'upstream-model' })
      + frame({}).repeat(40) + end), acc, () => {}, () => {}, undefined, { captureFrames: true })
    assert.equal(acc.generation?.returnedModel, 'upstream-model')
    assert.equal(acc.generation?.traceOmitted, true)
    assert.equal(acc.generation?.rawFrames?.length, 32)
  }
  for (const kind of ['progress', 'tool-stub', 'repeated-identity', 'text-tail', 'tool-tail', 'abort'] as const) {
    let cancelled = false; let interval: ReturnType<typeof setInterval> | undefined
    const abort = new AbortController()
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      if (kind === 'text-tail') c.enqueue(new TextEncoder().encode(frame({ content: 'complete' }, 'stop')))
      if (kind === 'tool-tail') c.enqueue(new TextEncoder().encode(frame(call(), 'tool_calls')))
      interval = setInterval(() => {
        if (kind === 'abort') abort.abort()
        else c.enqueue(new TextEncoder().encode(kind === 'tool-stub' ? frame({ tool_calls: [{ index: 0 }] })
          : kind === 'repeated-identity' ? frame({ tool_calls: [{ index: 0, id: 'same', type: 'function' }] }) : ': ping\n\n'))
      }, 2)
    }, cancel() { cancelled = true; if (interval) clearInterval(interval) } })
    const acc = createStreamAccumulator()
    const reading = readChatStream(new Response(stream), acc, () => {}, () => {}, undefined,
      { progressTimeoutMs: 20, terminalTimeoutMs: 20, captureFrames: true, signal: abort.signal })
    if (kind === 'text-tail') { await reading; assert.equal(acc.generation?.termination, 'tail_timeout') }
    else {
      const watchdog = setTimeout(() => abort.abort(), 1000)
      try { await assert.rejects(reading, { name: kind === 'abort' ? 'AbortError' : 'IncompleteStreamError' }) }
      finally { clearTimeout(watchdog) }
    }
    assert.equal(cancelled, true, 'all bounded exits release the stream even with continuing heartbeats')
  }
  {
    const acc = createStreamAccumulator()
    applySseData(acc, JSON.stringify({ choices: [], usage: { prompt_tokens: '2', completion_tokens: 1, total_tokens: 3 } }))
    assert.equal(acc.usage, undefined); assert.ok(acc.generation?.warnings?.length)
  }
  {
    let cancelled = false
    const empty = new TextEncoder().encode(frame({ tool_calls: [{ index: 0 }] }))
    await assert.rejects(readChatStream(new Response(new ReadableStream({
      pull(controller) { controller.enqueue(empty) }, cancel() { cancelled = true }
    })), createStreamAccumulator(), () => {}, () => {}, undefined, { progressTimeoutMs: 10 }),
    { name: 'IncompleteStreamError', reason: 'progress_timeout' })
    assert.equal(cancelled, true, 'already queued reads cannot starve the no-progress deadline')
  }
} finally { globalThis.fetch = originalFetch }
console.log('Provider contracts: identity, refusal, SSE framing, auxiliary responses and terminal tail passed')
