import assert from 'node:assert/strict'
import type { ChatMessage, ContentPart, ToolDefinition } from '../src/shared/types.ts'
import { assertContextFits, ContextBudgetExceededError, estimateMessageTokens, measureContextBudget } from '../src/main/agent/contextBudget.ts'
import { planCompactByTokens, sanitizeHistory } from '../src/main/agent/history.ts'
import { projectToolResultsToBudget } from '../src/main/agent/toolResultProjection.ts'
import { recoverProjectedToolResults, RECOVERY_NOTICE_TOKENS } from '../src/main/agent/toolResultRecovery.ts'
import { buildSummaryMessages, SUMMARY_OUTPUT_TOKENS } from '../src/main/agent/summaryInput.ts'

const call = { id: 'call-1', type: 'function' as const, function: { name: 'bash', arguments: '{"command":"build"}' } }
const group: ChatMessage[] = [
  { role: 'system', content: 'system rules' }, { role: 'user', content: 'Inspect build logs' },
  { role: 'assistant', content: null, tool_calls: [call] },
  { role: 'tool', tool_call_id: call.id, name: 'bash', content: `FIRST\n${'汉'.repeat(350_000)}\nFINAL_ERROR` }
]
const original = structuredClone(group)
const before = measureContextBudget(group, 262144)
assert.ok(before.estimatedRequestTokens > before.inputBudget)
assert.equal(before.inputBudget, 235929)
assert.ok(before.outputReserve >= 26214)
const projected = projectToolResultsToBudget(group, 262144)
assertContextFits(projected, 262144)
assert.equal(projected.length, group.length)
assert.deepEqual(projected[2].tool_calls, [call])
assert.equal(projected[3].tool_call_id, call.id)
assert.match(projected[3].content as string, /FIRST/); assert.match(projected[3].content as string, /FINAL_ERROR/)
assert.match(projected[3].content as string, /Context preview/)
assert.equal(sanitizeHistory(projected).length, projected.length, 'all call/result associations remain legal')
assert.deepEqual(group, original, 'request projections never mutate full history objects')

const calls = Array.from({ length: 50 }, (_, index) => ({ ...call, id: `parallel-${index}` }))
const parallel: ChatMessage[] = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'inspect all results' },
  { role: 'assistant', content: null, tool_calls: calls }, ...calls.map(tool => ({ role: 'tool' as const, tool_call_id: tool.id, content: '汉'.repeat(5000) }))]
const parallelView = projectToolResultsToBudget(parallel, 16000)
assertContextFits(parallelView, 16000)
assert.equal(parallelView.length, parallel.length)
assert.equal(sanitizeHistory(parallelView).length, parallel.length, 'all 50 results stay attached to their parallel call group')
assert.deepEqual(parallelView.slice(3).map(message => message.tool_call_id), calls.map(tool => tool.id))

const json = JSON.stringify({ task_id: 'task-1', sessionId: 'session-1', status: 'completed', reply: '证据'.repeat(100000),
  results: [{ path: 'src/main.ts', content: 'r'.repeat(100000) }], count: 3, done: true })
const jsonMessages: ChatMessage[] = [...group.slice(0, 3), { role: 'tool', tool_call_id: call.id, content: json }]
const jsonView = projectToolResultsToBudget(jsonMessages, 16000)
assertContextFits(jsonView, 16000)
const parsed = JSON.parse(jsonView[3].content as string)
assert.equal(parsed.task_id, 'task-1'); assert.equal(parsed.sessionId, 'session-1'); assert.equal(parsed.status, 'completed')
assert.equal(parsed.results[0].path, 'src/main.ts'); assert.equal(parsed.count, 3); assert.equal(parsed.done, true)
assert.match(parsed.reply, /Context preview/)
assert.equal(jsonMessages[3].content, json)
const entries = Array.from({ length: 10000 }, (_, index) => `item-${index}`)
const irreducible: ChatMessage[] = [...group.slice(0, 3), { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ entries }) }]
const irreducibleView = projectToolResultsToBudget(irreducible, 16000)
assert.deepEqual(JSON.parse(irreducibleView[3].content as string).entries, entries, 'short structured entries are never silently deleted to meet a cap')
assert.throws(() => assertContextFits(irreducibleView, 16000), ContextBudgetExceededError)
const preciseJson = `{"task_id":900719925474099312345,"reply":"${'汉'.repeat(20000)}"}`
const precise: ChatMessage[] = [...group.slice(0, 3), { role: 'tool', tool_call_id: call.id, content: preciseJson }]
assert.equal(projectToolResultsToBudget(precise, 16000)[3].content, preciseJson, 'numeric protocol identifiers must not be rounded during projection')

const image = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AA==', detail: 'auto' as const } }
const multimodal: ChatMessage[] = [...group.slice(0, 3), { role: 'tool', tool_call_id: call.id,
  content: [{ type: 'text', text: 'X'.repeat(1_000_000) }, image] }]
const imageView = projectToolResultsToBudget(multimodal, 16000)
assertContextFits(imageView, 16000)
assert.ok(Array.isArray(imageView[3].content))
assert.equal(imageView[3].content[1], image, 'image attachments are not dropped or rewritten to meet a text cap')

const tooLargeUser: ChatMessage[] = [{ role: 'system', content: 'rules' }, { role: 'user', content: '汉'.repeat(20000) }]
assert.deepEqual(projectToolResultsToBudget(tooLargeUser, 16000), tooLargeUser)
assert.throws(() => assertContextFits(tooLargeUser, 16000), ContextBudgetExceededError)
const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'tool', description: '汉'.repeat(20000), parameters: {} } }]
assert.throws(() => assertContextFits(group.slice(0, 1), 16000, tools), ContextBudgetExceededError)
const reserved = measureContextBudget(group.slice(0, 2), 16000, [], 10000)
assert.equal(reserved.inputBudget, 6000); assert.equal(reserved.outputReserve, 10000)
assert.ok(estimateMessageTokens({ ...group[3], tool_call_id: 'i'.repeat(10000) }) > estimateMessageTokens(group[3]), 'correlation IDs also consume tokens')

const shortHistory: ChatMessage[] = [{ role: 'user', content: 'old'.repeat(20000) }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'continue' }]
const split = planCompactByTokens(shortHistory, 2000, estimateMessageTokens)
assert.ok(split.toCompress.length > 0, 'three messages are not exempt from token-based compaction')
assert.equal(split.toKeep.at(-1), shortHistory.at(-1), 'the latest user input is retained in full')
assert.deepEqual([...split.toCompress, ...split.toKeep], shortHistory)
const atomic = planCompactByTokens(group.slice(2), 2000, estimateMessageTokens)
assert.equal(atomic.toCompress.length, 0); assert.equal(atomic.toKeep.length, 2)

const history: ChatMessage[] = Array.from({ length: 5000 }, (_, i) => ({ role: 'user', content: `${i === 0 ? 'START_GOAL' : i === 4999 ? 'LATEST_FINDING' : 'middle'} ${'😀汉'.repeat(1500)}` }))
const summary = buildSummaryMessages(history, 16000)
assertContextFits(summary, 16000, [], SUMMARY_OUTPUT_TOKENS)
assert.ok((summary[1].content as string).isWellFormed())
assert.match(summary[1].content as string, /START_GOAL/); assert.match(summary[1].content as string, /LATEST_FINDING/)
assert.match(summary[1].content as string, /history excerpts omitted/)
assert.throws(() => buildSummaryMessages(history, 128), ContextBudgetExceededError)

// Regression: screenshots were budgeted by base64 length (a 2MB capture ≈83k tokens),
// so image-heavy sessions were rejected as over budget even after compaction.
const bigImage = (chars: number) => ({ type: 'image_url' as const, image_url: { url: `data:image/png;base64,${'A'.repeat(chars)}` } })
const twoScreens: ChatMessage = { role: 'user', content: [{ type: 'text', text: '来修bug' }, bigImage(2_000_000), bigImage(200_000)] }
const screenTokens = estimateMessageTokens(twoScreens)
assert.ok(screenTokens < 6_000, `screenshots cost vision tokens, not base64 length; got ${screenTokens}`)

// Regression: giant tool_call arguments were re-sent every round and no projection
// or compaction could shrink them, so "still too large after compaction" was terminal.
const writeArgs = JSON.stringify({ file_path: 'src/heavy.ts', content: '汉'.repeat(300_000) })
const writeCall = { id: 'write-1', type: 'function' as const, function: { name: 'write', arguments: writeArgs } }
const writeGroup: ChatMessage[] = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'rewrite the file' },
  { role: 'assistant', content: null, tool_calls: [writeCall] }, { role: 'tool', tool_call_id: 'write-1', name: 'write', content: 'ok' }]
assert.ok(measureContextBudget(writeGroup, 16000).estimatedRequestTokens > measureContextBudget(writeGroup, 16000).inputBudget,
  'the giant call argument must overflow before projection')
const writeView = projectToolResultsToBudget(writeGroup, 16000)
assertContextFits(writeView, 16000)
const projectedArgs = JSON.parse(writeView[2].tool_calls![0].function.arguments)
assert.equal(projectedArgs.file_path, 'src/heavy.ts', 'correlation fields survive argument projection')
assert.match(projectedArgs.content, /Context preview/, 'payload is previewed, not silently deleted')
assert.equal(sanitizeHistory(writeView).length, writeView.length, 'projected call groups stay protocol-legal')
assert.equal(writeGroup[2].tool_calls![0].function.arguments, writeArgs, 'projection never rewrites the stored call')
const brokenArgs = '{not json' + '汉'.repeat(40_000)
const brokenGroup: ChatMessage[] = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'go' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function' as const, function: { name: 'write', arguments: brokenArgs } }] }]
assert.equal(projectToolResultsToBudget(brokenGroup, 16000)[2].tool_calls![0].function.arguments, brokenArgs,
  'non-JSON arguments stay byte-exact')

// Regression: the projection cap was sized per message without regard to how many
// messages had to share the room, so a fan-out of parallel calls floored at
// `unitCount × floor` and no cap fit — 52+ results over a 16k window ended in a
// terminal rejection. Recovery pointers were then appended *after* projection chose
// its caps, pushing an already-fitting request back over the line.
const fanOut = (count: number, content: (index: number) => string = () => '汉'.repeat(30_000)): ChatMessage[] => {
  const calls = Array.from({ length: count }, (_, index) => ({
    id: `fan-${index}`, type: 'function' as const, function: { name: 'bash', arguments: '{"command":"x"}' }
  }))
  return [{ role: 'system', content: 'rules' }, { role: 'user', content: 'run all' },
    { role: 'assistant', content: null, tool_calls: calls },
    ...calls.map((call, index) => ({ role: 'tool' as const, tool_call_id: call.id, name: 'bash', content: content(index) }))] as unknown as ChatMessage[]
}
/** The shipped sequence: reserve pointer room, project, attach pointers, then the gate. */
const ship = async (base: ChatMessage[], window: number, definitions: ToolDefinition[] = []) => {
  const archived = new Set<string>()
  const notices = base.filter(message => message.role === 'tool').length * RECOVERY_NOTICE_TOKENS
  const projected = projectToolResultsToBudget(base, window, definitions, notices)
  const view = await recoverProjectedToolResults(base, projected, async () => {
    const id = `out-${archived.size}`; archived.add(id); return id
  })
  return { view, archived }
}
for (const count of [50, 52, 60, 100, 200]) {
  const { view, archived } = await ship(fanOut(count), 16_000)
  try { assertContextFits(view, 16_000) } catch (error) {
    assert.fail(`a fan-out of ${count} parallel results must stay sendable: ${(error as Error).message}`)
  }
  assert.equal(sanitizeHistory(view).length, view.length, `every one of ${count} results keeps its call association`)
  assert.equal(archived.size, count, 'every shortened result has its own archived original')
  for (const message of view.filter(result => result.role === 'tool')) {
    const parts = message.content as ContentPart[]
    assert.match(parts[parts.length - 1].text!, /read_tool_output\(\{"output_id":"out-\d+"\}\)/,
      'a recovery pointer survives projection intact')
  }
}

// Regression: that room was spent in raw message tokens while the gate judges the
// *request*, which also carries the estimator factor and every tool schema. CJK content
// had slack left to hide it; ASCII content beside 30 tool schemas did not, and a request
// the projection had declared finished was rejected by the very check it sized itself to.
const schemas = (count: number) => Array.from({ length: count }, (_, index) => ({
  type: 'function', function: { name: `tool_${index}`, description: 'a description long enough to cost real tokens '.repeat(10), parameters: { type: 'object' } }
})) as unknown as ToolDefinition[]
for (const definitions of [[], schemas(30), schemas(60)] as ToolDefinition[][]) {
  const base = fanOut(20, index => `payload ${index} ${'result row '.repeat(3_000)}`)
  const { view } = await ship(base, 16_000, definitions)
  try { assertContextFits(view, 16_000, definitions) } catch (error) {
    assert.fail(`an ASCII fan-out beside ${definitions.length} tool schemas must stay sendable: ${(error as Error).message}`)
  }
}

// A JSON result whose every field is already shorter than its share cannot answer a cap
// at all, so it has to reach the omit level; otherwise the fan-out it belongs to could
// never be sent no matter how small the cap got.
const shortLeaves = JSON.stringify(Array.from({ length: 4_000 }, (_, index) => `/etc/paths/file_${index}.ts`))
const { view: leafView, archived: leafArchived } = await ship(fanOut(30, () => shortLeaves), 16_000)
assertContextFits(leafView, 16_000)
assert.equal(leafArchived.size, 30, 'unshrinkable JSON is archived and pointed to, not left in the request')

// With no output store there is nothing to point back to, so projection may shorten an
// excerpt but may never leave a result empty.
const withoutArchive = projectToolResultsToBudget(fanOut(60), 16_000)
assert.ok(withoutArchive.filter(message => message.role === 'tool')
  .every(message => typeof message.content === 'string' && message.content.trim().length > 0),
'tool results are never emptied when no recovery pointer can follow')
assertContextFits(withoutArchive, 16_000)

// Rejections name the largest contributor instead of failing opaquely.
try { assertContextFits(tooLargeUser, 16000); assert.fail('expected rejection') } catch (error) {
  assert.match((error as Error).message, /Largest parts: user≈\d+ tokens/)
}
console.log('Compaction policies: whole-request budgets, atomic tool projections, parallel fan-out room sharing, JSON/Unicode/images, short histories and aggregate summary bounds passed')
