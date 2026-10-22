import assert from 'node:assert/strict'
import { ProviderHttpError, ProviderStreamError } from '../src/main/llm/streamErrors.ts'
import { isProviderBusyError, shouldRetryProviderError } from '../src/main/llm/providerRetry.ts'
import { httpResponseError, parseTextCompletion } from '../src/main/llm/responseParsing.ts'

const gateway = { message: 'openai_error', type: 'bad_response_status_code', param: '', code: 'bad_response_status_code' }
for (const error of [gateway, { message: 'unrecognized upstream failure' }, 'opaque provider failure']) {
  const failure = new ProviderStreamError('provider', error, { httpStatus: 200 })
  assert.equal(failure.diagnostics.category, 'unknown')
  assert.equal(shouldRetryProviderError(failure), true)
  assert.equal(isProviderBusyError(failure), false)
}
for (const [error, category] of [
  [{ code: 'invalid_api_key' }, 'authentication'], [{ type: 'authentication_error' }, 'authentication'],
  [{ code: 'insufficient_quota' }, 'quota'], [{ type: 'TEXT_AUDIT_ANSWER_NOT_PASS' }, 'policy'],
  [{ code: 'invalid_request_error' }, 'invalid_request'], [{ code: 'model_not_found' }, 'invalid_request'],
] as const) {
  const failure = new ProviderStreamError('provider', error)
  assert.equal(failure.diagnostics.category, category)
  assert.equal(shouldRetryProviderError(failure), false)
}
for (const status of [400, 401, 403, 404, 422]) {
  const failure = await httpResponseError(Response.json({ error: { type: 'rate_limit_error', code: 429 } }, { status }))
  assert.equal(failure.status, status, 'a real client rejection takes precedence over embedded status')
  assert.equal(isProviderBusyError(failure), false)
  assert.equal(shouldRetryProviderError(failure), false)
}
for (const error of [{ code: 'invalid_api_key' }, { type: 'TEXT_AUDIT_ANSWER_NOT_PASS' }, { code: 'insufficient_quota' }]) {
  const failure = await httpResponseError(Response.json({ error }, { status: 429 }))
  assert.equal(isProviderBusyError(failure), true, 'HTTP 429 always follows the user busy retry configuration')
  assert.equal(shouldRetryProviderError(failure), true)
}
for (const detail of ['payload', 'content_type'] as const) {
  const failure = new ProviderStreamError(detail, { message: 'unknown error' })
  assert.equal(failure.diagnostics.category, 'protocol')
  assert.equal(shouldRetryProviderError(failure), false)
}
const envelope = { error: gateway, status: 503, request_id: 'envelope-id', trace: { raw: 'original trace' } }
const body = JSON.stringify(envelope)
const historicalDiagnostic = { error: gateway,
  trace: { previous: 'failed to parse tool call arguments as json' } }
for (const failure of [
  new ProviderStreamError('provider', gateway, { httpStatus: 200, envelope: historicalDiagnostic }),
  await httpResponseError(Response.json(historicalDiagnostic, { status: 503 }))
]) {
  assert.equal(shouldRetryProviderError(failure), true, 'attached historical diagnostics must not classify the current failure')
}
for (const failure of [
  new ProviderStreamError('provider', { message: 'failed to parse tool call arguments as json', code: 500 }),
  await httpResponseError(new Response('failed to parse tool call arguments as json', { status: 500 }))
]) assert.equal(shouldRetryProviderError(failure), false, 'a current malformed-history rejection stays terminal')
const cause = new Error('original transport cause')
const streamFailure = new ProviderStreamError('provider', gateway,
  { envelope, responseBody: body, httpStatus: 200, requestId: 'header-id', cause })
assert.equal(streamFailure.status, 503)
assert.equal(streamFailure.diagnostics.providerStatus, 503)
assert.equal(streamFailure.diagnostics.httpStatus, 200)
assert.equal(streamFailure.diagnostics.requestId, 'envelope-id')
assert.deepEqual(streamFailure.diagnostics.envelope, envelope)
assert.equal(streamFailure.diagnostics.responseBody, body)
assert.equal(streamFailure.cause, cause)
assert.deepEqual(streamFailure.diagnostics.cause, { name: 'Error', message: 'original transport cause' })
const httpFailure = await httpResponseError(new Response(body, { status: 503, headers: { 'x-request-id': 'http-id', 'retry-after': '2' } }))
assert.ok(httpFailure instanceof ProviderHttpError)
assert.equal(httpFailure.retryAfterMs, 2000)
assert.equal(httpFailure.diagnostics.httpStatus, 503)
assert.equal(httpFailure.diagnostics.responseBody, body)
assert.deepEqual(httpFailure.diagnostics.envelope, envelope)
assert.match(httpFailure.message, /original trace/)
assert.throws(() => parseTextCompletion(envelope, { httpStatus: 200 }), error => {
  assert.ok(error instanceof ProviderStreamError)
  assert.deepEqual(error.diagnostics.envelope, envelope)
  assert.equal(error.diagnostics.requestId, 'envelope-id')
  return true
})
console.log('Provider failures: unknown recovery, deterministic rejection, 429 priority and complete diagnostics passed')
