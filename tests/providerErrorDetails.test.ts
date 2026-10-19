import assert from 'node:assert/strict'
import { applySseData, createStreamAccumulator } from '../src/main/llm/sseAccumulator.ts'
import { readChatStream } from '../src/main/llm/streamResponse.ts'
import { ProviderStreamError } from '../src/main/llm/streamErrors.ts'

const original = { message: 'Upstream failed: Authorization: Bearer original-value\nMore details',
  code: 503, type: 'upstream_error', param: null,
  metadata: { raw: 'nested upstream cause', debug: { token: 'returned-value' } } }
assert.throws(() => applySseData(createStreamAccumulator(), JSON.stringify({ error: original })), e => {
  assert.ok(e instanceof ProviderStreamError)
  assert.ok(e.message.includes(JSON.stringify(original, null, 2)), 'provider error fields must not be redacted or omitted')
  return true
})

for (const error of ['capacity exhausted', { code: 'no_message', metadata: { raw: 'the actual reason' } },
  { detail: 'backend unavailable' }, [1, 'unusual error payload']]) {
  const wire = JSON.stringify({ error })
  assert.throws(() => applySseData(createStreamAccumulator(), wire), e => {
    assert.ok(e instanceof ProviderStreamError)
    assert.ok(e.message.includes(typeof error === 'string' ? error : JSON.stringify(error, null, 2)))
    return true
  })
}

for (const header of ['x-request-id', 'request-id']) {
  let cancelled = false
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: original })}\n\n`))
  }, cancel() { cancelled = true } }), { headers: { [header]: 'header-request-id' } })
  await assert.rejects(readChatStream(response, createStreamAccumulator(), () => {
    throw new Error('error frames must not emit model tokens')
  }, () => {}, { provider: 'my-provider', model: 'my-model' }), e => {
    assert.ok(e instanceof ProviderStreamError)
    assert.match(e.message, /Provider: my-provider\nModel: my-model\nRequest ID: header-request-id/)
    assert.ok(e.message.includes(JSON.stringify(original, null, 2)))
    return true
  })
  assert.ok(cancelled); assert.equal(response.body!.locked, false)
}

await assert.rejects(readChatStream(new Response('data: {"error":"failed","request_id":"frame-id"}\n\n',
  { headers: { 'x-request-id': 'header-id' } }), createStreamAccumulator(), () => {}, () => {}), e => {
  assert.ok(e instanceof ProviderStreamError)
  assert.match(e.message, /Request ID: frame-id/)
  return true
})
console.log('Provider error details: original nested fields, string errors, request context and cleanup passed')
