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

console.log('persisted Agent callback tests passed')
