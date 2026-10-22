import assert from 'node:assert/strict'
import { register } from 'node:module'
import { retryMessageKey, type AgentRetryEvent } from '../src/shared/agentRetry.ts'
import { HttpError } from '../src/main/net/retryCore.ts'
import { ProviderStreamError } from '../src/main/llm/streamErrors.ts'

const status = { failedAttempt: 2, maxRetries: -1 }
assert.equal(retryMessageKey(status), 'chat.retrying', 'legacy retry events retain their existing message')
assert.equal(retryMessageKey({ ...status, reason: 'network' }), 'chat.retrying')
assert.equal(retryMessageKey({ ...status, reason: 'provider_busy' }), 'chat.providerBusy')
assert.equal(retryMessageKey({ ...status, reason: 'provider_error' }), 'chat.providerErrorRetrying')

register('./helpers/providerBusyLoader.mjs', import.meta.url)
const { createIpcAgentEventSink } = await import('../src/main/ipc/agentCallbacks.ts')
const events: AgentRetryEvent[] = []
const ipc = createIpcAgentEventSink({ send(channel: string, event: AgentRetryEvent) {
  assert.equal(channel, 'agent:retry')
  events.push(event)
} } as Electron.WebContents)

ipc.retry?.('session-a', 1, -1, new HttpError(429, 'busy'))
ipc.retry?.('session-b', 2, 5, new HttpError(503, 'upstream service unavailable'))
ipc.retry?.('session-a', 2, -1, new Error('fetch failed'))
ipc.retry?.('session-b', 3, 5, new ProviderStreamError('provider', {
  message: 'openai_error', type: 'bad_response_status_code', code: 'bad_response_status_code'
}))
ipc.retry?.('session-a', 3, -1, new ProviderStreamError('provider', { type: 'rate_limit_error' }))
ipc.retry?.('session-b', 4, 5, new ProviderStreamError('provider', { type: 'overloaded_error' }))

assert.deepEqual(events, [
  { sessionId: 'session-a', failedAttempt: 1, maxRetries: -1, reason: 'provider_busy' },
  { sessionId: 'session-b', failedAttempt: 2, maxRetries: 5, reason: 'provider_error' },
  { sessionId: 'session-a', failedAttempt: 2, maxRetries: -1, reason: 'network' },
  { sessionId: 'session-b', failedAttempt: 3, maxRetries: 5, reason: 'provider_error' },
  { sessionId: 'session-a', failedAttempt: 3, maxRetries: -1, reason: 'provider_busy' },
  { sessionId: 'session-b', failedAttempt: 4, maxRetries: 5, reason: 'provider_error' }
], 'interleaved retry notifications keep the source session, retry limit and failure category')
assert.deepEqual(events.map(retryMessageKey), [
  'chat.providerBusy', 'chat.providerErrorRetrying', 'chat.retrying',
  'chat.providerErrorRetrying', 'chat.providerBusy', 'chat.providerErrorRetrying'
])
console.log('Agent retry status: provider errors, busy signals, network errors and per-session IPC passed')
