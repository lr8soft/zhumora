import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { register } from 'node:module'
import { ToolOutputStore } from '../src/main/tools/toolOutputStore.ts'
import { executeShellCommand } from '../src/main/tools/shell.ts'
import { projectToolResultsToBudget } from '../src/main/agent/toolResultProjection.ts'
import { recoverProjectedToolResults } from '../src/main/agent/toolResultRecovery.ts'
import { serializeMessages } from '../src/main/llm/responseParsing.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { extractTextContent } from '../src/shared/multimodal.ts'
import type { ChatMessage } from '../src/shared/types.ts'

register('./helpers/compactionLoader.mjs', import.meta.url)
const { AutoCompactor } = await import('../src/main/agent/autoCompact.ts')
const { WorkingConversation } = await import('../src/main/agent/workingConversation.ts')
const { executeToolCall } = await import('../src/main/agent/toolExecutor.ts')
const root = await fs.mkdtemp(path.join(process.cwd(), '.test-output-recovery-'))
const store = new ToolOutputStore(path.join(root, 'store'))
try {
  const log = Array.from({ length: 3000 }, (_, i) => `entry-${i}: ${'x'.repeat(120)}`).join('\n')
  const script = path.join(root, 'log.cjs')
  await fs.writeFile(script, `process.stdout.write(${JSON.stringify(log)}); process.exitCode = 7`)
  const preview = await executeShellCommand({ workspacePath: root, sessionId: 'one', outputStore: store,
    command: `"${process.execPath}" "${script}"` })
  assert.match(preview, /exit code: 7/)
  assert.doesNotMatch(preview, /entry-1500:/)
  const id = /"output_id":"([a-f0-9-]+)"/.exec(preview)![1]
  const page = await store.read('one', id, { pattern: 'entry-1500:' })
  assert.match(page, /entry-1500:/)
  await assert.rejects(store.read('two', id), /unavailable|expired/)

  const registry = new ToolRegistry()
  registry.register('capture', { definition: { type: 'function', function: { name: 'capture', description: '', parameters: {} } },
    async execute() { return { content: 'preview'.repeat(10000), outputRef: { id },
      attachments: [{ type: 'image', mediaType: 'image/png', base64: 'aGVsbG8=' }] } } })
  const executed = await executeToolCall({ registry, context: { workspacePath: root },
    toolCall: { id: 'capture', type: 'function', function: { name: 'capture', arguments: '{}' } } })
  assert.equal(executed.llmMessage.toolOutputRef!.id, id)
  const projectedCapture = projectToolResultsToBudget([executed.llmMessage], 4000)
  const recoveredCapture = await recoverProjectedToolResults([executed.llmMessage], projectedCapture,
    async () => { throw new Error('A preview must never replace the full output') })
  assert.equal(recoveredCapture[0].toolOutputRef!.id, id)
  assert.equal((recoveredCapture[0].content as { type: string }[]).filter(part => part.type === 'image_url').length, 1)

  const blocked = new AbortController()
  const stalledStore = { createWriter: async () => ({ append: () => new Promise<void>(() => {}), finish: async () => id, discard: async () => {} }) } as unknown as ToolOutputStore
  const stalled = executeShellCommand({ workspacePath: root, sessionId: 'one', outputStore: stalledStore,
    command: `"${process.execPath}" "${script}"`, signal: blocked.signal })
  setTimeout(() => blocked.abort(), 150)
  let deadline: ReturnType<typeof setTimeout> | undefined
  await assert.rejects(Promise.race([stalled, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Cancellation stalled')), 1000) })]), /aborted/)
  clearTimeout(deadline)

  // Timeout keeps chunks accepted before the process is disconnected, even when a disk append is delayed.
  const mixed = path.join(root, 'mixed.cjs')
  await fs.writeFile(mixed, "process.stdout.write('A-LOG\\n'.repeat(3000)); process.stderr.write('B-ERROR\\n'.repeat(3000)); setTimeout(() => {}, 5000)")
  const captured: string[] = []
  let firstAppend = true
  const delayedStore = { createWriter: async () => ({
    append: async (text: string) => {
      if (firstAppend) { firstAppend = false; await new Promise(resolve => setTimeout(resolve, 1150)) }
      captured.push(text)
    }, finish: async () => id, discard: async () => {}
  }) } as unknown as ToolOutputStore
  const timed = await executeShellCommand({ workspacePath: root, sessionId: 'one', outputStore: delayedStore,
    command: `"${process.execPath}" "${mixed}"`, timeoutSeconds: 1 })
  assert.match(timed, /timed out/)
  assert.match(captured.join(''), /B-ERROR/)
  assert.match(timed, /Full output saved/)

  const business = path.join(root, 'business.cjs')
  const completed = path.join(root, 'completed.txt')
  await fs.writeFile(business, `process.stdout.write('LOG'.repeat(10000));require('node:fs').writeFileSync(${JSON.stringify(completed)},'business completed')`)
  for (const failure of ['open', 'append', 'finish', 'blocked'] as const) {
    let discards = 0
    const failingStore = { createWriter: async () => {
      if (failure === 'open') throw new Error('permission denied')
      return { append: async () => { if (failure === 'append') throw new Error('quota exceeded'); if (failure === 'blocked') await new Promise(() => {}) },
        finish: async () => { if (failure === 'finish') throw new Error('disk full'); return id }, discard: async () => { discards++ } }
    } } as unknown as ToolOutputStore
    const result = await executeShellCommand({ workspacePath: root, sessionId: 'one', outputStore: failingStore,
      command: `"${process.execPath}" "${business}"`, timeoutSeconds: 1 })
    assert.match(result, /exit code: 0/)
    assert.match(result, /Log storage failed/)
    assert.doesNotMatch(result, /Full output saved|timed out/)
    assert.equal(await fs.readFile(completed, 'utf8'), 'business completed')
    await fs.unlink(completed)
    if (failure !== 'open') assert.ok(discards > 0)
  }

  // The last indivisible tool group forces the actual AutoCompactor projection path.
  const json = JSON.stringify({ task_id: 'immutable-task', reply: 'head\n' + 'payload'.repeat(60000) + '\ntail' })
  const call = { id: 'call', type: 'function' as const, function: { name: 'external', arguments: '{}' } }
  const originals: ChatMessage[] = [{ role: 'system', content: 'inspect' },
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', content: json, tool_call_id: call.id }]
  const conversation = new WorkingConversation('inspect')
  conversation.append(originals[1], 'assistant')
  conversation.append(originals[2], 'result')
  const provider = { id: 'p', name: 'p', baseUrl: 'https://fixture.invalid/v1', apiKey: '', defaultModel: 'm', enabled: true }
  const compactor = new AutoCompactor({ provider, contextWindow: 16000,
    archiveToolOutput: text => store.save('one', text) }, null)
  await compactor.applyIfOverThreshold(conversation, 'recovery test')
  const recovered = conversation.messages.at(-1)!
  assert.ok(Array.isArray(recovered.content))
  const content = recovered.content as { type: 'text'; text: string }[]
  assert.equal(JSON.parse(content[0].text).task_id, 'immutable-task')
  assert.match(content.at(-1)!.text, /read_tool_output/)
  const originalPage = await store.read('one', recovered.toolOutputRef!.id, { pattern: 'immutable-task' })
  assert.match(originalPage, /immutable-task/)
  assert.equal(originals.at(-1)!.content, json, 'persisted source is untouched')
  const payload = serializeMessages(conversation.messages, provider, 'm', true)
  assert.ok(!('toolOutputRef' in payload.at(-1)!), 'internal metadata never reaches the provider')
  assert.equal(conversation.messages.at(-2)!.tool_calls![0].id, recovered.tool_call_id)

  const smaller = projectToolResultsToBudget(conversation.messages, 4000)
  let saves = 0
  const repeated = await recoverProjectedToolResults(conversation.messages, smaller, async () => { saves++; return 'unused' })
  assert.equal(saves, 0, 'further projection keeps the original artifact')
  assert.equal(repeated.at(-1)!.toolOutputRef!.id, recovered.toolOutputRef!.id)
  assert.match(extractTextContent(repeated.at(-1)!.content), /read_tool_output/)

  const small = new WorkingConversation('inspect')
  const twin = ['BIG'.repeat(60000), 'M'.repeat(1000)]
  const calls = twin.map((_, index) => ({ id: `twin-${index}`, type: 'function' as const, function: { name: 'external', arguments: '{}' } }))
  small.append({ role: 'assistant', content: null, tool_calls: calls }, 'assistant')
  twin.forEach((text, index) => small.append({ role: 'tool', tool_call_id: calls[index].id, content: text }, `tool-${index}`))
  await new AutoCompactor({ provider, contextWindow: 1000, archiveToolOutput: text => store.save('one', text) }, null)
    .applyIfOverThreshold(small, 'reference overhead')
  small.messages.filter(message => message.role === 'tool').forEach((message, index) => {
    if (extractTextContent(message.content) !== twin[index]) assert.ok(message.toolOutputRef, 'secondary cuts also have original artifacts')
  })
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(recoverProjectedToolResults(originals, smaller, text => store.save('one', text), aborted.signal), /abort/i)
  console.log('Tool result recovery: streamed command logs, session isolation, real compactor, JSON/ID integrity, repeated projection and cancellation passed')
} finally {
  await store.dispose()
  assert.equal(path.dirname(root), process.cwd())
  assert.ok(path.basename(root).startsWith('.test-output-recovery-'))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
