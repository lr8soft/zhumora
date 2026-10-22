import assert from 'node:assert/strict'
import { register } from 'node:module'
import { AgentAbortedError, type ChatMessage, type ToolDefinition } from '../src/shared/types.ts'
import { assertContextFits, ContextBudgetExceededError } from '../src/main/agent/contextBudget.ts'
import { WorkingConversation } from '../src/main/agent/workingConversation.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'

register('./helpers/compactionLoader.mjs', import.meta.url)
const { runAgent } = await import('../src/main/agent/runner.ts')
const { AutoCompactor } = await import('../src/main/agent/autoCompact.ts')
const { finalizeRun } = await import('../src/main/agent/finalizeRun.ts')
const { planAutoCompact } = await import('../src/main/agent/compaction.ts')
const previousFetch = globalThis.fetch
const provider = { id: 'compaction', name: 'test', baseUrl: 'https://fixture.invalid/v1', apiKey: '', defaultModel: 'test', enabled: true, contextWindow: 262144 }
const call = { id: 'read-1', type: 'function' as const, function: { name: 'read', arguments: '{}' } }
const large = `FIRST_LOG\n${'X'.repeat(1_100_000)}\nLAST_ERROR`
const history: ChatMessage[] = [
  { role: 'user', content: 'old'.repeat(100000) }, { role: 'assistant', content: 'earlier reply' },
  { role: 'user', content: 'inspect' }, { role: 'assistant', content: null, tool_calls: [call] },
  { role: 'tool', tool_call_id: call.id, content: large }
]
interface Request { messages: ChatMessage[]; tools?: ToolDefinition[]; stream?: boolean; max_tokens?: number }
const requests: Request[] = []
const persisted: { upToMessageId: string; summary: string }[] = []
let summaryResult = 'Previous work, decisions and file paths summarized.'
let summaryFails = false
let abortSummary: AbortController | undefined
let nextStream: ((request: Request) => Response) | undefined
const sse = (delta: object, finish = 'stop') => new Response([
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`, 'data: [DONE]\n\n'
].join(''), { headers: { 'content-type': 'text/event-stream' } })
const reset = () => { requests.length = 0; persisted.length = 0; summaryFails = false; abortSummary = undefined;
  summaryResult = 'Previous work, decisions and file paths summarized.'; nextStream = undefined }
const run = (messages: ChatMessage[], extra: Partial<Parameters<typeof runAgent>[0]> = {}, callbacks: Parameters<typeof runAgent>[1] = {}) => runAgent({
  provider, workspacePath: 'D:/fixture', messages, messageIds: messages.map((_, index) => `id-${index}`), compaction: null,
  memoryEnabled: false, maxRounds: 4, toolRegistry: new ToolRegistry(), onAutoCompact: state => persisted.push(state), ...extra
}, callbacks)

try {
  globalThis.fetch = async (_url, init) => {
    const body: Request = JSON.parse(init!.body as string)
    // Inspect the real outgoing payload: a too-large request must never reach this adapter.
    assertContextFits(body.messages, provider.contextWindow, body.tools, body.stream ? undefined : body.max_tokens)
    requests.push(body)
    if (body.stream) return nextStream?.(body) ?? sse({ content: 'finished' })
    abortSummary?.abort()
    return summaryFails ? new Response('summary unavailable', { status: 503 })
      : Response.json({ choices: [{ finish_reason: 'stop', message: { content: summaryResult } }] })
  }

  const original = structuredClone(history)
  await run(history)
  assert.equal(requests.filter(request => !request.stream).length, 1)
  const request = requests.find(request => request.stream)!
  const tool = request.messages.find(message => message.role === 'tool')!
  assert.ok((tool.content as string).length < large.length)
  assert.match(tool.content as string, /FIRST_LOG/); assert.match(tool.content as string, /LAST_ERROR/)
  const index = request.messages.indexOf(tool)
  assert.equal(request.messages[index - 1].tool_calls![0].id, tool.tool_call_id)
  assert.equal(persisted.length, 1); assert.equal(persisted[0].upToMessageId, 'id-2')
  assert.deepEqual(history, original, 'complete stored history was not rewritten by compaction/projection')

  // An indivisible two-message tool group has no historical prefix but must still be bounded.
  reset()
  await run(history.slice(-2))
  assert.equal(requests.length, 1); assert.ok(requests[0].stream)
  assert.equal(persisted.length, 0)

  // Three effective messages (four with system) are not exempt from compaction.
  reset()
  const short: ChatMessage[] = [{ role: 'user', content: 'old'.repeat(400000) }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'continue' }]
  await run(short)
  assert.equal(requests.filter(request => !request.stream).length, 1)
  assert.equal(requests.at(-1)!.messages.at(-1)!.content, 'continue')
  assert.equal(persisted.length, 1)

  // Failed/empty summaries may only fall back in the working copy, never overwrite the stored state.
  for (const failure of ['http', 'empty']) {
    reset(); summaryFails = failure === 'http'; summaryResult = ''
    await run(history)
    assert.equal(persisted.length, 0)
    assert.equal(requests.filter(request => request.stream).length, 1)
    assert.deepEqual(history, original)
  }
  reset(); summaryFails = true
  const priorState = { upToMessageId: 'id-0', summary: 'Previously archived work' }
  await run(history, { compaction: priorState })
  assert.deepEqual(priorState, { upToMessageId: 'id-0', summary: 'Previously archived work' })
  assert.equal(persisted.length, 0, 'failure cannot replace an existing compaction record')

  reset()
  let completed = false
  await assert.rejects(run([{ role: 'user', content: '汉'.repeat(300000) }], {}, { onComplete: () => { completed = true } }), ContextBudgetExceededError)
  assert.equal(requests.length, 0); assert.equal(completed, false)
  await assert.rejects(run([{ role: 'user', content: 'hi' }], { systemPromptExtra: '汉'.repeat(300000) }), ContextBudgetExceededError)
  assert.equal(requests.length, 0, 'an oversized fixed system prompt does not trigger an unnecessary summary request')
  const schemaRegistry = new ToolRegistry()
  schemaRegistry.register('large_schema', { definition: { type: 'function', function: { name: 'large_schema', description: '汉'.repeat(300000), parameters: {} } },
    execute: async () => ({ content: 'unused' }) })
  await assert.rejects(run(history, { toolRegistry: schemaRegistry }), ContextBudgetExceededError)
  assert.equal(requests.length, 0, 'a large tool snapshot is rejected, never filtered to make it fit')

  // Even a model violating the summary output limit cannot persist an unusable oversized summary or send the next request.
  reset(); summaryResult = '汉'.repeat(300000)
  await assert.rejects(run(history), ContextBudgetExceededError)
  assert.equal(requests.length, 1); assert.equal(requests[0].stream, false); assert.equal(persisted.length, 0)

  reset(); abortSummary = new AbortController()
  await assert.rejects(run(history, { signal: abortSummary.signal }), AgentAbortedError)
  assert.equal(requests.length, 1); assert.equal(persisted.length, 0)
  assert.ok(requests.every(request => !request.stream), 'abort during summary cannot start the next generation')

  // No-progress rechecks are finite; a fitted conversation does not re-summarize on its next round.
  reset()
  const working = new WorkingConversation('rules')
  history.forEach((message, index) => working.append(message, `id-${index}`))
  const compactor = new AutoCompactor({ provider, contextWindow: provider.contextWindow, persist: state => persisted.push(state) }, null)
  await compactor.applyIfOverThreshold(working, 'test')
  assert.equal(working.ids.length, working.messages.length)
  assert.deepEqual(working.ids, [null, null, 'id-3', 'id-4'])
  const summaryCalls = requests.length
  await compactor.applyIfOverThreshold(working, 'again')
  assert.equal(requests.length, summaryCalls)

  // The last compressed message may be synthetic: choose the last actual ID in the prefix.
  reset()
  const synthetic = new WorkingConversation('rules')
  synthetic.append({ role: 'user', content: 'old'.repeat(400000) }, 'actual-old')
  synthetic.appendSyntheticUser('prior guidance'.repeat(10000))
  synthetic.append(history[3], 'call-id'); synthetic.append(history[4], 'tool-id')
  const syntheticCompactor = new AutoCompactor({ provider, contextWindow: provider.contextWindow, persist: state => persisted.push(state) }, null)
  await syntheticCompactor.applyIfOverThreshold(synthetic, 'synthetic boundary')
  assert.equal(persisted[0].upToMessageId, 'actual-old')

  // Real runner reaches max rounds after a huge tool result: finalization must use the same budget gate.
  reset()
  let executions = 0; let rawPersisted = ''; let streamCalls = 0
  const registry = new ToolRegistry()
  registry.register('read', { definition: { type: 'function', function: { name: 'read', description: 'read', parameters: {} } }, permission: 'safe',
    execute: async () => { executions++; return { content: large } } })
  nextStream = () => ++streamCalls === 1 ? sse({ tool_calls: [{ index: 0, ...call }] }, 'tool_calls') : sse({ content: 'final progress' })
  let finalContent = ''; completed = false
  await assert.rejects(run([{ role: 'user', content: 'inspect' }], { maxRounds: 1, toolRegistry: registry }, {
    onAssistantMessage: content => { finalContent = content; return 'assistant-id' },
    onComplete: () => { completed = true },
    onToolResult: (_id, _name, result) => { rawPersisted = result; return 'tool-id' }
  }), { name: 'AgentCompletionError', reason: 'limit' })
  assert.equal(executions, 1); assert.equal(rawPersisted, large)
  assert.equal(finalContent, 'final progress'); assert.equal(completed, false)
  const last = requests.at(-1)!
  assert.ok(last.stream); assert.equal(last.tools, undefined)
  assert.match(last.messages.at(-1)!.content as string, /agent run has been stopped/)

  reset()
  const impossible = new WorkingConversation('汉'.repeat(300000))
  const finalCompactor = new AutoCompactor({ provider, contextWindow: provider.contextWindow }, null)
  await assert.rejects(finalizeRun(provider, undefined, undefined, 'test', impossible, [], {}, undefined, finalCompactor), ContextBudgetExceededError)
  assert.equal(requests.length, 0, 'finalizer does not swallow budget rejection and report success')

  reset()
  const hugeHistory = Array.from({ length: 4000 }, (_, i): ChatMessage => ({ role: 'user', content: `goal-${i} ${'汉'.repeat(4000)}` }))
  hugeHistory.push({ role: 'user', content: 'latest task' })
  const plan = await planAutoCompact(hugeHistory, { ...provider, contextWindow: 16000 }, undefined, 16000)
  assert.ok(plan.summary); assert.equal(requests.length, 1)
  assertContextFits(requests[0].messages, 16000, [], requests[0].max_tokens)
  assert.equal(plan.toKeep.at(-1)!.content, 'latest task')
  console.log('Production compaction: 262k overflow, short/atomic histories, complete request guards, bounded summaries, ID/state preservation, failures, abort and finalization passed')
} finally { globalThis.fetch = previousFetch }
