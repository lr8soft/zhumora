import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runDatabaseMigrations, DATABASE_SCHEMA_VERSION } from '../src/main/store/migrations.ts'
import { messageFromRow } from '../src/main/store/messageRows.ts'
import { normalizeProviderResponseOptions, validateProviderResponseOptions } from '../src/shared/providerResponse.ts'
import { serializeMessages, retryAfterMilliseconds } from '../src/main/llm/responseParsing.ts'
import { nodeStatus } from '../src/renderer/src/flow/projection.ts'
import { turnStatus } from '../src/renderer/src/flow/status.ts'
import { applyAssistantEnd, applyGenerationUpdate, applyHistorySnapshot } from '../src/renderer/src/agentEvents.ts'
import { decideTurnOutcome } from '../src/main/agent/turnDecision.ts'
import { applyReasoningParams } from '../src/main/llm/reasoning.ts'
import { withRetry, HttpError } from '../src/main/net/retryCore.ts'
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '../src/main/store/settingsNormalization.ts'
const db = new Database(':memory:')
runDatabaseMigrations(db)
assert.equal(db.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
db.close()
const legacy = new Database(':memory:')
legacy.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,content TEXT,reasoning TEXT); INSERT INTO messages VALUES('m','original','thought'); PRAGMA user_version=8;")
runDatabaseMigrations(legacy)
assert.deepEqual(legacy.prepare('SELECT content,reasoning,generation FROM messages').get(),
  { content: 'original', reasoning: 'thought', generation: null })
legacy.close()
const generation = { version: 1 as const, status: 'incomplete' as const, providerId: 'p', model: 'm', finishReason: 'length' }
const m = messageFromRow({ id: 'm', session_id: 's', role: 'assistant', content: 'partial', timestamp: 1, status: 'done',
  generation: JSON.stringify(generation) })
assert.deepEqual(m.generation, generation)
assert.equal(nodeStatus(m, true), 'unresolved'); assert.equal(turnStatus([m]), 'unresolved')
const event = applyAssistantEnd('s', 'm', 'partial', [], undefined, [], 1, generation)
assert.deepEqual(event[0].generation, generation)
const newer = { ...generation, status: 'complete' as const, assessmentRevision: 1 }
const assessed = applyGenerationUpdate('m', newer, event)
assert.equal(assessed[0].content, 'partial')
assert.deepEqual(applyGenerationUpdate('m', generation, assessed), assessed, 'late metadata cannot revert the assessment')
assert.equal(applyHistorySnapshot(event, assessed, true)[0].generation!.status, 'complete', 'an older in-flight snapshot cannot revert assessment')
assert.equal(applyHistorySnapshot(event, assessed, false)[0].generation!.status, 'complete', 'a read settling after run cleanup cannot revert assessment')
assert.equal(applyAssistantEnd('s', 'm', 'partial', [], undefined, assessed, 1, generation)[0].generation!.status, 'complete')
assert.equal(messageFromRow({ id: 'old', session_id: 's', role: 'assistant', content: 'old', timestamp: 0 }).generation, undefined)
for (const status of ['checking', 'unverified'] as const) {
  const legacyGeneration = { version: 1 as const, status, purpose: 'review' as const,
    reason: 'Original assessment', requestId: 'original-request', assessmentRevision: 2 }
  const original = { id: 'legacy-' + status, session_id: 's', role: 'assistant' as const,
    content: 'Original answer', timestamp: 0, status: 'done' as const, generation: JSON.stringify(legacyGeneration) }
  const restored = messageFromRow(original)
  assert.deepEqual(restored.generation, legacyGeneration, 'retired review metadata remains readable')
  assert.equal(restored.content, original.content)
  assert.equal(nodeStatus(restored, false), 'unresolved', 'old assessments cannot become successful after migration')
}
assert.deepEqual(normalizeProviderResponseOptions({}), { captureResponses: false, reasoningHistory: 'auto', outputTokenParameter: 'auto' })
assert.throws(() => validateProviderResponseOptions({ captureResponses: 'yes' } as never))
assert.throws(() => validateProviderResponseOptions({ outputTokenParameter: 'invalid' } as never), /outputTokenParameter/)
const provider = { id: 'p', name: 'p', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', defaultModel: 'm', enabled: true }
for (const outputTokenParameter of ['auto', 'max_tokens', 'max_completion_tokens'] as const) {
  validateProviderResponseOptions({ outputTokenParameter })
  const migrated = normalizeSettings({ schemaVersion: 17, providers: [{ ...provider, outputTokenParameter }] })
  assert.equal(migrated.schemaVersion, SETTINGS_SCHEMA_VERSION)
  assert.equal(migrated.providers[0].outputTokenParameter, outputTokenParameter)
  assert.deepEqual(normalizeSettings(migrated), migrated, 'normalization is idempotent')
}
assert.equal(normalizeSettings({ schemaVersion: 17, providers: [provider] }).providers[0].outputTokenParameter, 'auto')
for (const completionReview of [undefined, false, true]) {
  const currentProvider = { ...provider, apiKey: 'kept-key', headers: { 'x-custom': 'kept-header' },
    maxConcurrency: 3, allowSubagents: false, captureResponses: true, reasoningHistory: 'preserve' as const,
    outputTokenParameter: 'max_completion_tokens' as const, temperature: 0.25 }
  const legacyProvider = completionReview === undefined ? currentProvider : { ...currentProvider, completionReview }
  const input = { schemaVersion: 18, maxRetries: -1, providers: [legacyProvider] }
  const migrated = normalizeSettings(input)
  assert.equal(migrated.schemaVersion, 19)
  assert.equal(Object.hasOwn(migrated.providers[0], 'completionReview'), false, 'old review settings are removed at the storage boundary')
  assert.deepEqual(migrated.providers[0], normalizeSettings({ providers: [currentProvider] }).providers[0],
    'retiring review preserves all other provider settings')
  assert.equal(migrated.maxRetries, -1, 'settings migration must preserve unlimited retries')
  assert.deepEqual(normalizeSettings(migrated), migrated, 'review retirement migration is idempotent')
  if (completionReview !== undefined) assert.equal(Object.hasOwn(legacyProvider, 'completionReview'), true, 'normalization does not mutate input')
}
const messages = [{ role: 'assistant' as const, content: 'answer', reasoning: 'thought', reasoningSource: { providerId: 'p', model: 'm' } }]
assert.equal(serializeMessages(messages, provider, 'm', true)[0].reasoning_content, 'thought')
assert.equal(serializeMessages(messages, provider, 'other', true)[0].reasoning_content, undefined)
assert.equal(serializeMessages(messages, provider, 'm', false)[0].reasoning_content, undefined)
assert.equal(serializeMessages(messages, { ...provider, reasoningHistory: 'omit' }, 'm', true)[0].reasoning_content, undefined)
assert.equal(serializeMessages(messages, { ...provider, id: 'other' }, 'm', true)[0].reasoning_content, undefined)
const qwen = { ...provider, baseUrl: 'http://localhost:30000/v1' }
const qwenBody: Record<string, unknown> = {}
applyReasoningParams(qwenBody, qwen, 'high', 'Qwen3.8-27B')
assert.equal(qwenBody.reasoning_effort, 'xhigh')
assert.equal(serializeMessages(messages, qwen, 'm', true)[0].reasoning_content, undefined)
assert.equal(serializeMessages(messages, { ...qwen, reasoningHistory: 'preserve' }, 'm', true)[0].reasoning_content, 'thought')
assert.equal(retryAfterMilliseconds(new Headers({ 'retry-after': '2' })), 2000)
assert.equal(retryAfterMilliseconds(new Headers({ 'retry-after': 'garbage' })), undefined)
assert.equal(retryAfterMilliseconds(new Headers({ 'retry-after': 'Wed, 21 Oct 2026 00:00:02 GMT' }),
  Date.parse('Wed, 21 Oct 2026 00:00:00 GMT')), 2000)
assert.equal(retryAfterMilliseconds(new Headers({ 'retry-after-ms': '25' })), 25)
{
  let attempts = 0; let aborted: AbortController | undefined
  assert.equal(await withRetry(async () => { if (++attempts === 1) throw new HttpError(429, 'busy', 0); return 'ok' },
    { maxRetries: 1, label: 'retry-after' }), 'ok')
  assert.equal(attempts, 2)
  aborted = new AbortController()
  await assert.rejects(withRetry(async () => { throw new HttpError(429, 'busy', 60000) },
    { maxRetries: -1, label: 'retry-after abort', signal: aborted.signal, onRetry: () => aborted!.abort() }), { name: 'AbortError' })
}
assert.deepEqual(decideTurnOutcome({ finishReason: 'stop', refusal: 'declined', toolCallCount: 0, toolCallsValid: true,
  contentEmpty: true, canRecoverEmptyResponse: true, canRecoverTruncation: true }), { kind: 'fail', cause: 'refused' })
console.log('Generation state: review retirement migration, legacy metadata, UI, reasoning binding and retry hints passed')
