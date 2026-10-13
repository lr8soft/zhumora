import assert from 'node:assert/strict'
import { register } from 'node:module'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { AgentAbortedError, type ChatMessage } from '../src/shared/types.ts'
import { appendCoordinationMessages } from '../src/main/agent/runInbox.ts'
import { WorkingConversation } from '../src/main/agent/workingConversation.ts'
import { completeTurn } from '../src/main/agent/completeTurn.ts'

register('./helpers/runnerCollaborationLoader.mjs', import.meta.url)
const { runAgent } = await import('../src/main/agent/runner.ts')
const originalFetch = globalThis.fetch
const provider = { id: 'test', name: 'test', baseUrl: 'https://fixture.invalid/v1', apiKey: '', defaultModel: 'test', enabled: true }
const sse = (delta: object, finish = 'stop') => new Response([
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`, 'data: [DONE]\n\n'
].join(''), { headers: { 'content-type': 'text/event-stream' } })

try {
  const registry = new ToolRegistry()
  registry.register('read', { definition: { type: 'function', function: { name: 'read', description: 'read', parameters: {} } },
    permission: 'safe', execute: async () => ({ content: 'file contents' }) })
  const requests: { messages: ChatMessage[]; tools?: unknown[] }[] = []
  const pending: string[] = []; const order: string[] = []; const outputs: string[] = []; let completed = 0
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init!.body as string))
    if (requests.length === 1) {
      pending.push('First clarification arrived during the tool-call round')
      return sse({ tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, 'tool_calls')
    }
    if (requests.length === 2) {
      pending.push('Late parent evidence arrived while the final answer streamed')
      return sse({ content: 'premature conclusion' })
    }
    return sse({ content: 'final after considering parent evidence' })
  }
  await runAgent({ provider, workspacePath: 'D:/fixture', messages: [{ role: 'user', content: 'inspect' }], messageIds: ['u'],
    compaction: null, memoryEnabled: false, maxRounds: 5, toolRegistry: registry,
    takeCoordinationMessages: () => pending.splice(0).map((content, i) => {
      order.push('persist-guidance'); return { message: { role: 'user' as const, content }, id: `guidance-${requests.length}-${i}` }
    }) }, {
    onAssistantMessage: content => { order.push('persist-assistant'); outputs.push(content); return `a-${outputs.length}` },
    onComplete: () => { completed++ }
  })
  assert.equal(requests.length, 3, 'late evidence continues the same bounded run rather than accepting a stale final')
  const second = requests[1].messages
  const assistant = second.findIndex(message => message.tool_calls?.length)
  assert.equal(second[assistant + 1].role, 'tool')
  assert.equal(second[assistant + 1].tool_call_id, 'read-1')
  assert.equal(second[assistant + 2].role, 'user', 'guidance follows the complete tool-result group')
  assert.equal(requests[2].messages.at(-2)!.content, 'premature conclusion')
  assert.match(requests[2].messages.at(-1)!.content as string, /Late parent evidence/)
  assert.deepEqual(order, ['persist-assistant', 'persist-guidance', 'persist-assistant', 'persist-guidance', 'persist-assistant'])
  assert.equal(outputs.at(-1), 'final after considering parent evidence'); assert.equal(completed, 1)
  assert.ok(requests.every(request => request.tools?.length === 1), 'each round keeps its full tool snapshot')

  // Cancellation prevents guidance delivery and subsequent tools/requests.
  const abort = new AbortController(); let calls = 0; let takes = 0; let executed = 0
  registry.register('read', { definition: { type: 'function', function: { name: 'read', description: '', parameters: {} } },
    execute: async () => { executed++; abort.abort(); return { content: 'read' } } })
  globalThis.fetch = async () => { calls++; return sse({ tool_calls: [
    { index: 0, id: 'one', type: 'function', function: { name: 'read', arguments: '{}' } },
    { index: 1, id: 'two', type: 'function', function: { name: 'read', arguments: '{}' } }
  ] }, 'tool_calls') }
  await assert.rejects(runAgent({ provider, workspacePath: '', messages: [{ role: 'user', content: 'inspect' }], messageIds: ['u'],
    compaction: null, signal: abort.signal, toolRegistry: registry, memoryEnabled: false,
    takeCoordinationMessages: () => { takes++; return [] } }, {}), AgentAbortedError)
  assert.equal(calls, 1); assert.equal(executed, 1); assert.equal(takes, 1)
} finally { globalThis.fetch = originalFetch }

// A hard stop never consumes guidance or triggers an extra collaboration retry.
const conversation = new WorkingConversation('system')
let drained = false
assert.equal(completeTurn({ kind: 'complete', truncatedNotice: true, cause: 'length' },
  { content: 'partial', toolCalls: [], reasoning: '', usage: null, finishReason: 'length' }, 1,
  { conversation, allAssistantMessages: [], cb: {}, takeCoordinationMessages: () => { drained = true; return [] } }), true)
assert.equal(drained, false)
appendCoordinationMessages(conversation, [])
assert.deepEqual(conversation.ids, [null])
console.log('Production runner collaboration: valid tool sequences, ID-safe checkpoints, late finals, cancellation and hard-stop budget passed')
