import assert from 'node:assert/strict'
import { register } from 'node:module'
import type { ProviderConfig } from '../src/shared/types.ts'

register(new URL('./helpers/providerRequestLoader.mjs', import.meta.url), import.meta.url)
const { streamChat, complete } = await import('../src/main/llm/provider.ts')
const { listProviderModels } = await import('../src/main/llm/models.ts')
const { fetchContextWindow, detectProviderContextWindow } = await import('../src/main/agent/context.ts')
const { probeReasoningCapability } = await import('../src/main/llm/reasoningCapability.ts')

const originalFetch = globalThis.fetch
const requests: { url: string; headers: Headers; body?: Record<string, unknown> }[] = []
globalThis.fetch = async (input, init) => {
  const url = String(input)
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  requests.push({ url, headers: new Headers(init?.headers), body })
  if (url.endsWith('/chat/completions')) {
    if (body?.stream) return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    return Response.json({ choices: [{ message: { content: 'ok' } }] })
  }
  if (url.endsWith('/models')) {
    const tenant = new Headers(init?.headers).get('x-tenant')
    return Response.json({ data: [{ id: 'model', context_length: tenant === 'two' ? 64000 : 32000 }] })
  }
  return Response.json({ chat_template_caps: { supports_reasoning_effort: true }, default_generation_settings: { n_ctx: 48000 } })
}

try {
  const provider: ProviderConfig = {
    id: 'p', name: 'header-test', baseUrl: 'https://provider.test/v1', apiKey: 'bearer-key',
    defaultModel: 'model', enabled: true,
    headers: { AUTHORIZATION: 'Token custom', 'X-API-Key': 'custom-key', 'X-Tenant': 'one' }
  }
  const messages = [{ role: 'user' as const, content: 'hello' }]
  assert.equal((await streamChat(provider, { messages })).content, 'ok')
  assert.equal(await complete(provider, messages), 'ok')
  assert.equal((await listProviderModels(provider)).models[0].id, 'model')
  assert.equal(await fetchContextWindow(provider), 32000)
  await probeReasoningCapability(provider)
  for (const request of requests) {
    assert.equal(request.headers.get('authorization'), 'Token custom', request.url)
    assert.equal(request.headers.get('x-api-key'), 'custom-key', request.url)
    assert.equal(request.headers.get('content-type'), 'application/json', request.url)
  }
  assert.equal(requests.length, 5, 'stream, complete, model list, context and capability all use custom headers')

  const beforeCached = requests.length
  await listProviderModels({ ...provider, headers: { 'x-tenant': 'one', 'x-api-key': 'custom-key', authorization: 'Token custom' } })
  await fetchContextWindow(provider)
  assert.equal(requests.length, beforeCached, 'semantic equivalents reuse caches')
  const changed = { ...provider, apiKey: '', headers: { 'X-API-Key': 'other-key', 'X-Tenant': 'two' } }
  await listProviderModels(changed)
  assert.equal(await fetchContextWindow(changed), 64000, 'changed headers invalidate context cache')
  assert.equal(requests.length, beforeCached + 2, 'changed headers invalidate both caches')
  assert.equal(requests.at(-1)!.headers.get('authorization'), null, 'custom-only auth does not invent a Bearer token')

  // Exercise fallback discovery endpoints using the same custom credentials.
  const discoveryFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/models')) {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ data: [] })
    }
    return discoveryFetch(input, init)
  }
  assert.equal(await detectProviderContextWindow(changed), 48000)
  assert.ok(requests.at(-1)!.url.endsWith('/props'))
  assert.equal(requests.at(-1)!.headers.get('x-api-key'), 'other-key')

  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, headers: new Headers(init?.headers) })
    if (url.endsWith('/api/show')) return Response.json({ model_info: { 'llama.context_length': 96000 } })
    return new Response('', { status: 404 })
  }
  assert.equal(await detectProviderContextWindow(changed), 96000)
  assert.ok(requests.at(-1)!.url.endsWith('/api/show'))
  assert.equal(requests.at(-1)!.headers.get('x-api-key'), 'other-key')
  globalThis.fetch = discoveryFetch

  const beforeParallel = requests.length
  await Promise.all([
    streamChat(provider, { messages }),
    streamChat({ ...changed, headers: { authorization: 'Token second' } }, { messages })
  ])
  assert.deepEqual(requests.slice(beforeParallel).map(request => request.headers.get('authorization')),
    ['Token custom', 'Token second'], 'concurrent providers keep their own headers')

  const beforeInvalid = requests.length
  await assert.rejects(complete({ ...provider, headers: { X: 'secret\ninjected' } }, messages), /Invalid provider/)
  assert.equal(requests.length, beforeInvalid, 'invalid headers never reach fetch')
} finally {
  globalThis.fetch = originalFetch
}
console.log('Provider request paths and header-sensitive cache integration tests passed')
