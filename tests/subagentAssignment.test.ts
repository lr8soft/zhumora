import assert from 'node:assert/strict'
import { normalizeSubagentAssignment, formatSubagentAssignment, assignmentOwnsFile } from '../src/main/agent/subagentAssignment.ts'
import { RunInbox, appendCoordinationMessages } from '../src/main/agent/runInbox.ts'
import { WorkingConversation } from '../src/main/agent/workingConversation.ts'
import { sanitizeHistoryWithIds } from '../src/main/agent/history.ts'
import { normalizeParallelPreference } from '../src/shared/subagents.ts'

assert.equal(normalizeSubagentAssignment({ prompt: 'legacy task' }), undefined)
assert.equal(normalizeParallelPreference(undefined), false)
assert.equal(normalizeParallelPreference(true), true)
for (const invalid of [null, 'true', 1, {}]) assert.throws(() => normalizeParallelPreference(invalid), /boolean/)
const input = { prompt: 'Change one file', targetFile: 'src/a.ts', role: 'implementer' as const,
  context: 'Use the agreed API.', acceptanceCriteria: ['Preserve exports'], validationCommand: 'node tests/a.test.ts', dependsOn: ['task-a'] }
const assignment = normalizeSubagentAssignment(input)!
input.acceptanceCriteria[0] = 'mutated'
assert.match(formatSubagentAssignment(assignment), /Preserve exports/)
assert.match(formatSubagentAssignment(assignment), /node tests\/a.test.ts/)
assert.equal(assignmentOwnsFile(assignment), true)
for (const role of ['explorer', 'reviewer', 'verifier'] as const) {
  const a = normalizeSubagentAssignment({ prompt: 'Inspect one question', role })!
  assert.equal(assignmentOwnsFile(a), false)
  assert.match(formatSubagentAssignment(a), /Do not edit project files/)
}
for (const bad of [{ role: 'unknown' }, { role: 'implementer' }, { context: 1 }, { dependsOn: ['a', 'a'] }, { dependsOn: 'a' },
  { acceptanceCriteria: [''] }, { context: 'x'.repeat(24000) }]) {
  assert.throws(() => normalizeSubagentAssignment({ prompt: 'x', ...bad } as never))
}
const inbox = new RunInbox()
assert.equal(inbox.enqueue('Use the new API', 'parent', 'task-a'), 'delivery-1')
assert.equal(inbox.drain()[0].taskId, 'task-a')
assert.deepEqual(inbox.drain(), [])
for (let i = 0; i < 4; i++) inbox.enqueue('x'.repeat(12000), 'parent', 'task-a')
assert.throws(() => inbox.enqueue('overflow', 'parent', 'task-a'), /budget/)
assert.equal(inbox.drain().length, 4, 'budget rejection must not evict existing messages')
inbox.close(); assert.throws(() => inbox.enqueue('late', 'parent', 'task-a'), /ended/)
assert.deepEqual(inbox.drain(), [])
const conversation = new WorkingConversation('system')
conversation.append({ role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'read', arguments: '{}' } }] }, 'a')
conversation.append({ role: 'tool', content: 'result', tool_call_id: 't' }, 't')
appendCoordinationMessages(conversation, [{ message: { role: 'user', content: 'Parent guidance' }, id: 'guidance' },
  { message: { role: 'user', content: 'Completed child notice' }, id: null }])
assert.equal(conversation.messages.length, conversation.ids.length)
assert.deepEqual(sanitizeHistoryWithIds(conversation.messages, conversation.ids).messages, conversation.messages)
assert.deepEqual(conversation.ids, [null, 'a', 't', 'guidance', null])
console.log('Structured subagent roles, work order bounds and coordination inbox/history boundaries passed')
