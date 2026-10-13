import assert from 'node:assert/strict'
import { createSubagentFixture } from './helpers/subagentFixture.ts'
import { splitConversationTurns } from '../src/renderer/src/flow/history.ts'
import { messageFromRow } from '../src/main/store/messageRows.ts'

const request = { description: 'Inspect API', prompt: 'Identify the export contract', role: 'explorer' as const,
  targetFile: 'src/a.ts', context: 'Read the public exports only.', acceptanceCriteria: ['Cite exported symbols'] }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

// Work orders, live guidance, persistence/graph boundaries and notifications use the real SessionService.
{
  const f = createSubagentFixture()
  try {
    const parent = await f.root(); const other = await f.root('unrelated')
    const child = await parent.scope.spawn(request)
    const options = f.running.get(child.session_id)!.options
    assert.equal(child.role, 'explorer')
    assert.match(options.systemPromptRole!, /Do not edit project files/)
    assert.match(options.messages[0].content as string, /Role: explorer/)
    assert.match(options.messages[0].content as string, /Cite exported symbols/)
    assert.deepEqual(options.promptRuntime!.tools, parent.options.promptRuntime!.tools, 'roles do not filter tools')
    const implementer = await parent.scope.spawn({ description: 'implement', prompt: 'Update exports', role: 'implementer', targetFile: 'src/a.ts' })
    assert.equal(implementer.status, 'running', 'a read target does not claim exclusive write ownership')
    await assert.rejects(parent.scope.spawn({ description: 'conflict', prompt: 'Update exports', role: 'implementer', targetFile: 'src/A.ts' }), /File already assigned/)
    assert.equal(parent.scope.list().tasks.length, 2)
    assert.equal(parent.options.takeCoordinationMessages!(true).length, 1, 'one bounded reminder prevents an unnoticed early final')
    assert.equal(parent.options.takeCoordinationMessages!(true).length, 0, 'the reminder cannot loop indefinitely')
    await assert.rejects(other.scope.spawn({ ...request, dependsOn: [child.task_id] }), /owned/)
    assert.throws(() => other.scope.send(child.task_id, 'foreign update'), /owned/)
    const receipt = parent.scope.send(child.task_id, 'The agreed API returns a Result object.')
    assert.equal(receipt.status, 'queued'); assert.equal(f.messages.get(child.session_id)!.length, 1)
    const delivered = options.takeCoordinationMessages!()
    assert.equal(delivered.length, 1); assert.ok(delivered[0].id)
    assert.deepEqual(f.messages.get(child.session_id)!.at(-1)!.coordination, { parentSessionId: parent.session.id, taskId: child.task_id })
    assert.deepEqual(options.takeCoordinationMessages!(), [], 'guidance delivered once')
    assert.equal(splitConversationTurns(f.messages.get(child.session_id)!).length, 1, 'guidance remains inside its original child turn')
    const count = f.sessions.size
    await assert.rejects(parent.scope.spawn({ ...request, dependsOn: [child.task_id] }), /Dependency/)
    assert.equal(f.sessions.size, count, 'blocked work never creates a phantom child session')
    f.finish(child.session_id, 'Exported function: parse(input): Result'); await turn()
    const notices = parent.options.takeCoordinationMessages!()
    assert.equal(notices.length, 1); assert.match(notices[0].message.content as string, /Subagent completion notice/)
    assert.doesNotMatch(notices[0].message.content as string, /Exported function/, 'full replies still require wait for graph/audit correlation')
    assert.equal(parent.options.takeCoordinationMessages!().length, 0)
    const dependent = await parent.scope.spawn({ ...request, dependsOn: [child.task_id], targetFile: 'src/b.ts' })
    assert.deepEqual(dependent.dependsOn, [child.task_id])
    assert.match(f.messages.get(dependent.session_id)![0].content, /Dependency evidence/)
    assert.match(f.messages.get(dependent.session_id)![0].content, /parse\(input\): Result/)
    assert.throws(() => parent.scope.send(child.task_id, 'late'), /continue_subagent/)
    const continued = await parent.scope.continue(child.task_id, 'Check another symbol in the same file')
    assert.equal(continued.role, 'explorer')
    assert.equal(splitConversationTurns(f.messages.get(child.session_id)!).length, 2)
    await assert.rejects(parent.scope.spawn({ ...request, dependsOn: [child.task_id] }), /Stale/)
    assert.equal(parent.scope.list().tasks.some(task => task.task_id === child.task_id), false, 'inventory contains only current turns')
    const pending = f.running.get(continued.session_id)!.options
    parent.scope.send(continued.task_id, 'discard on stop')
    await parent.scope.cancel(continued.task_id)
    assert.deepEqual(pending.takeCoordinationMessages!(), [], 'abort drops queued guidance and prevents late writes')
    f.setDelegation(false)
    assert.ok(parent.scope.list().tasks.length, 'inspection remains available when delegation is disabled')
    await parent.scope.cancel(implementer.task_id)
    await parent.scope.cancel(dependent.task_id)
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}

// Failed prerequisites and live message permissions cannot be bypassed.
{
  const f = createSubagentFixture()
  try {
    const parent = await f.root('permissions', 'manual')
    const child = await parent.scope.spawn(request)
    const allowed = parent.options.permissionCheck!('send_subagent_message', { task_id: child.task_id, message: 'context' })
    assert.ok(f.permissions.hasPending(parent.session.id))
    f.permissions.respond(f.pending.at(-1)!.id, false); assert.equal(await allowed, false)
    assert.equal(f.running.get(child.session_id)!.options.takeCoordinationMessages!().length, 0)
    f.running.get(child.session_id)!.reject(new Error('cannot determine interface')); await turn()
    await assert.rejects(parent.scope.spawn({ ...request, dependsOn: [child.task_id] }), /failed/)
    assert.equal(parent.scope.list().tasks[0].status, 'failed')
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}

const restored = messageFromRow({ id: 'guidance', session_id: 'child', role: 'user', content: 'new evidence', timestamp: 2,
  coordination_parent_id: 'parent', coordination_task_id: 'task' })
const initial = messageFromRow({ id: 'input', session_id: 'child', role: 'user', content: 'original work order', timestamp: 1 })
assert.equal(splitConversationTurns([initial, restored]).length, 1, 'DB-restored coordination provenance preserves turn boundaries')
assert.equal(messageFromRow({ id: 'bad-image', session_id: 's', role: 'user', content: '', timestamp: 1, images: 'bad' }).images, undefined)
// Task inventory is paged by text size, not by an arbitrary agent-count cap.
{
  const f = createSubagentFixture()
  try {
    const parent = await f.root(); const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push((await parent.scope.spawn({ ...request,
      targetFile: `${Array.from({ length: 18 }, () => 'segment'.repeat(10)).join('/')}/file-${i}.ts` })).task_id)
    const observed: string[] = []; let cursor: string | undefined; let pages = 0
    do {
      const page = parent.scope.list(cursor)
      assert.ok(page.tasks.every(task => task.reply === undefined))
      observed.push(...page.tasks.map(task => task.task_id)); cursor = page.next_cursor; pages++
    } while (cursor)
    assert.ok(pages > 1); assert.deepEqual(observed, ids)
    assert.equal(new Set(observed).size, ids.length)
    assert.throws(() => parent.scope.list('unknown'), /owned/)
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}
{
  const f = createSubagentFixture()
  try {
    const session = f.service.createSession('parallel preference')
    const handle = await f.service.sendMessage({ sessionId: session.id, message: { text: 'Execute the existing plan.' }, preferParallel: true })
    void handle.completion.catch(() => {})
    assert.match(f.running.get(session.id)!.options.systemPromptRole!, /user selected parallel collaboration/)
    assert.equal(f.messages.get(session.id)![0].content, 'Execute the existing plan.', 'preference does not rewrite the user input')
    const count = f.messages.get(session.id)!.length
    await assert.rejects(f.service.sendMessage({ sessionId: session.id, message: { text: 'invalid' }, preferParallel: 'true' as never }), /boolean/)
    assert.equal(f.messages.get(session.id)!.length, count)
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}
console.log('Subagent collaboration: roles, dependencies, live guidance, inventory, permissions, notifications and persisted turn boundaries passed')
