import assert from 'node:assert/strict'
import type { ChatMessage, ToolDefinition } from '../src/shared/types.ts'
import { assertContextFits, ContextBudgetExceededError, estimateMessageTokens, measureContextBudget } from '../src/main/agent/contextBudget.ts'
import { planCompactByTokens, sanitizeHistory } from '../src/main/agent/history.ts'
import { projectToolResultsToBudget } from '../src/main/agent/toolResultProjection.ts'
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
console.log('Compaction policies: whole-request budgets, atomic tool projections, JSON/Unicode/images, short histories and aggregate summary bounds passed')
