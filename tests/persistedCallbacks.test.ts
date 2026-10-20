import assert from 'node:assert/strict'
import type { UIMessage } from '../src/shared/types.ts'
import { createPersistedAgentCallbacks } from '../src/main/agent/persistedCallbacks.ts'

const messages: UIMessage[] = []
const events: string[] = []
let sequence = 0
const callbacks = createPersistedAgentCallbacks('s1', {
  addMessage: message => messages.push(message),
  addTokenUsage: () => {}
}, () => `m${++sequence}`, {
  assistantStart: (_sessionId, messageId) => events.push(`start:${messageId}`),
  token: (_sessionId, messageId, token) => events.push(`token:${messageId}:${token}`),
  assistantEnd: (_sessionId, messageId, content) => events.push(`end:${messageId}:${content}`),
  toolResult: message => events.push(`tool:${message.id}`),
  complete: (_sessionId, messageId) => events.push(`complete:${messageId}`)
})

callbacks.onToken?.('hel')
callbacks.onToken?.('lo')
const assistantId = callbacks.onAssistantMessage?.('hello', [], undefined)
assert.equal(assistantId, 'm1')
assert.deepEqual(events.slice(0, 4), [
  'start:m1', 'token:m1:hel', 'token:m1:lo', 'end:m1:hello'
])
assert.equal(messages[0].id, 'm1')
assert.equal(messages[0].content, 'hello')

const toolId = callbacks.onToolResult?.('call1', 'read', 'result', false, 3)
assert.equal(toolId, 'm2')
assert.equal(events.at(-1), 'tool:m2')
callbacks.onComplete?.()
assert.equal(events.at(-1), 'complete:m1')

// The extracted round state preserves reasoning IDs, error idempotence and stale-run write protection.
{
  const saved: UIMessage[] = []; const emitted: string[] = []; let id = 0; let current = true
  const round = createPersistedAgentCallbacks('round', {
    addMessage: message => saved.push(message), addTokenUsage: () => {}
  }, () => `r${++id}`, {
    assistantStart: (_session, messageId) => emitted.push(`start:${messageId}`),
    reasoning: (_session, messageId) => emitted.push(`reasoning:${messageId}`),
    error: () => emitted.push('error')
  }, () => current)
  round.onReasoningToken?.('thinking'); round.onToken?.('partial'); round.onError?.(new Error('failed'))
  round.onError?.(new Error('duplicate'))
  assert.deepEqual(emitted, ['start:r1', 'reasoning:r1', 'error'])
  assert.equal(saved.length, 1); assert.equal(saved[0].id, 'r1'); assert.equal(saved[0].reasoning, 'thinking')
  current = false
  assert.equal(round.onToolResult?.('late', 'read', 'late', false, 0), null)
  assert.equal(round.onAssistantMessage?.('late', []), null)
  round.onComplete?.(); assert.equal(saved.length, 1)
}

{
  const saved: UIMessage[] = []; let id = 0; let errors = 0
  const cb = createPersistedAgentCallbacks('failed', { addMessage: m => saved.push(m), addTokenUsage() {} },
    () => `f${++id}`, { error: () => { errors++ } })
  cb.onAssistantMessage?.('partial finalization', [])
  cb.onError?.(new Error('incomplete output')); cb.onError?.(new Error('duplicate'))
  assert.equal(saved.length, 2, 'failure after a persisted round must leave a separate error record')
  assert.equal(saved[0].content, 'partial finalization'); assert.equal(saved[0].status, 'done')
  assert.equal(saved[1].status, 'error'); assert.equal(errors, 1)
}
{
  const saved: UIMessage[] = []; const assessments: string[] = []; let ends = 0; let current = true
  const cb = createPersistedAgentCallbacks('assessment', {
    addMessage: message => saved.push(message), addTokenUsage() {},
    updateMessageGeneration: (id, value) => assessments.push(`${id}:${value.assessmentRevision}`)
  }, () => 'candidate', { assistantEnd: () => { ends++ } }, () => current)
  cb.onAssistantMessage?.('original candidate', [], 'original reasoning', { version: 1, status: 'checking' })
  cb.onAssistantGeneration?.('another-id', { version: 1, status: 'complete' })
  assert.deepEqual(assessments, [])
  cb.onAssistantGeneration?.('candidate', { version: 1, status: 'unverified' })
  cb.onAssistantGeneration?.('candidate', { version: 1, status: 'complete' })
  assert.deepEqual(assessments, ['candidate:1', 'candidate:2'])
  assert.equal(saved.length, 1); assert.equal(ends, 1, 'assessment cannot send the candidate twice to Bot/TTS')
  assert.equal(saved[0].content, 'original candidate'); assert.equal(saved[0].reasoning, 'original reasoning')
  current = false
  cb.onAssistantGeneration?.('candidate', { version: 1, status: 'incomplete' })
  assert.equal(assessments.length, 2); assert.equal(saved[0].generation?.status, 'complete')
}
console.log('persisted Agent callback tests passed')
