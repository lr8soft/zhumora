import assert from 'node:assert/strict'
import { register } from 'node:module'
import { ProviderRequestConcurrency } from '../src/main/llm/requestConcurrency.ts'
import { normalizeProviderConcurrency } from '../src/shared/providerConcurrency.ts'
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '../src/main/store/settingsNormalization.ts'
import type { ProviderConfig } from '../src/shared/types.ts'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const config: ProviderConfig = { id: 'p', name: 'test', baseUrl: 'https://provider.test/v1', apiKey: '', defaultModel: 'm', enabled: true }
assert.equal(normalizeProviderConcurrency(undefined), null)
assert.equal(normalizeProviderConcurrency(null), null)
assert.equal(normalizeProviderConcurrency(3), 3)
for (const value of [0, -1, 1.5, NaN, Infinity, '2', false]) assert.throws(() => normalizeProviderConcurrency(value))
const migrated = normalizeSettings({ schemaVersion: 13, providers: [config] })
assert.equal(migrated.schemaVersion, SETTINGS_SCHEMA_VERSION)
assert.equal(migrated.providers[0].maxConcurrency, null)
const saved = normalizeSettings({ ...migrated, providers: [{ ...config, maxConcurrency: 2 }] })
assert.equal(normalizeSettings(JSON.parse(JSON.stringify(saved))).providers[0].maxConcurrency, 2)
assert.equal(normalizeSettings({ ...saved, providers: [{ ...config, maxConcurrency: null }] }).providers[0].maxConcurrency, null)
assert.throws(() => normalizeSettings({ providers: [{ ...config, maxConcurrency: 0 }] }))

{
  const gate = new ProviderRequestConcurrency()
  const first = await gate.acquire('p', 1)
  let secondStarted = false, thirdStarted = false
  const second = gate.acquire('p', 1).then(release => { secondStarted = true; return release })
  const third = gate.acquire('p', 1).then(release => { thirdStarted = true; return release })
  const other = await gate.acquire('other', 1)
  const occupancy = gate.snapshot()
  assert.deepEqual(occupancy.p, { active: 1, waiting: 2 })
  occupancy.p.active = 100
  assert.equal(gate.snapshot().p.active, 1, 'routing snapshots cannot mutate the request gate')
  await turn()
  assert.equal(secondStarted, false, 'same provider queues behind its active request')
  assert.equal(thirdStarted, false)
  other()
  first(); first()
  const releaseSecond = await second
  assert.equal(thirdStarted, false, 'a double release cannot over-admit another request')
  releaseSecond()
  const releaseThird = await third
  releaseThird()
  assert.deepEqual(gate.snapshot(), {}, 'idle occupancy entries do not linger')
  gate.dispose()
}
{
  const gate = new ProviderRequestConcurrency()
  const active = await gate.acquire('p', 1)
  const abort = new AbortController()
  const cancelled = assert.rejects(gate.acquire('p', 1, abort.signal), { name: 'AbortError' })
  abort.abort()
  await cancelled
  const already = new AbortController(); already.abort()
  await assert.rejects(gate.acquire('p', 1, already.signal), { name: 'AbortError' })
  const next = gate.acquire('p', 1)
  active()
  ;(await next)()
  gate.dispose()
}
{
  const gate = new ProviderRequestConcurrency()
  const first = await gate.acquire('p', 1)
  const second = gate.acquire('p', 1)
  gate.configureLimits([{ id: 'p', maxConcurrency: 2 }])
  const releaseSecond = await second
  let thirdStarted = false
  const third = gate.acquire('p', 2).then(release => { thirdStarted = true; return release })
  gate.configureLimits([{ id: 'p', maxConcurrency: 1 }])
  first()
  await turn()
  assert.equal(thirdStarted, false, 'lowering the cap lets active requests finish without granting more')
  releaseSecond()
  const releaseThird = await third
  const fourth = gate.acquire('p', 1)
  gate.configureLimits([{ id: 'p', maxConcurrency: null }])
  const releaseFourth = await fourth
  releaseThird(); releaseFourth()
  const unlimited = await Promise.all(Array.from({ length: 12 }, () => gate.acquire('p', null)))
  unlimited.forEach(release => release())
  const active = await gate.acquire('p', 1)
  const pending = assert.rejects(gate.acquire('p', 1), { name: 'AbortError' })
  gate.dispose(); await pending; active()
  await assert.rejects(gate.acquire('p', null), { name: 'AbortError' })
}

register(new URL('./helpers/providerRequestLoader.mjs', import.meta.url), import.meta.url)
const { streamChat, complete } = await import('../src/main/llm/provider.ts')
const originalFetch = globalThis.fetch
const messages = [{ role: 'user' as const, content: 'hello' }]
const limited = { ...config, maxConcurrency: 1 }
let streamController: ReadableStreamDefaultController<Uint8Array>
const calls: string[] = []
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body))
  calls.push(`${body.model}:${body.stream}`)
  if (body.stream) return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    streamController = controller
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
    init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
  } }))
  if (body.model === 'fail') return new Response('failed', { status: 400 })
  return Response.json({ choices: [{ message: { content: 'ok' } }] })
}
try {
  const abortStream = new AbortController()
  const streaming = streamChat(limited, { messages, signal: abortStream.signal })
  await turn()
  assert.deepEqual(calls, ['m:true'])
  const pendingAbort = new AbortController()
  const cancelled = assert.rejects(complete(limited, messages, 'cancelled', 200, pendingAbort.signal), { name: 'AbortError' })
  const queued = complete(limited, messages, 'second-model')
  pendingAbort.abort(); await cancelled
  assert.deepEqual(calls, ['m:true'], 'stream occupancy lasts until EOF/abort, not just HTTP headers')
  assert.equal(await complete({ ...limited, id: 'other' }, messages, 'other-provider'), 'ok')
  abortStream.abort()
  assert.equal((await streaming).content, 'partial')
  assert.equal(await queued, 'ok')
  assert.deepEqual(calls, ['m:true', 'other-provider:false', 'second-model:false'], 'models share a provider cap; other providers remain independent')
  await assert.rejects(complete(limited, messages, 'fail'), /400/)
  assert.equal(await complete(limited, messages), 'ok', 'HTTP failure releases its permit')
  const normal = streamChat(limited, { messages })
  await turn()
  const afterEof = complete(limited, messages, 'after-eof')
  streamController!.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
  streamController!.close()
  await normal
  assert.equal(await afterEof, 'ok', 'normal stream completion releases its permit')
} finally { globalThis.fetch = originalFetch }
console.log('Provider concurrency: settings migration, FIFO, isolation, unlimited, live limits, cancellation, disposal and stream/complete integration passed')
