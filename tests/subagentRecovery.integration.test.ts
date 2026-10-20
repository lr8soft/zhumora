import assert from 'node:assert/strict'
import { createSubagentFixture } from './helpers/subagentFixture.ts'
import { AgentAbortedError, type ToolCall } from '../src/shared/types.ts'

const request = { description: 'Single-file task', prompt: 'ORIGINAL_GOAL: implement the agreed parser and validate it.', role: 'implementer' as const,
  targetFile: 'src/parser.ts', context: 'Keep the public interface.', acceptanceCriteria: ['Parser handles empty input'] }
const networkFailure = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

// Tool execution failures are recoverable steps, never task terminal events.
{
  const f = createSubagentFixture()
  try {
    const parent = await f.root()
    const child = await parent.scope.spawn(request)
    const running = f.running.get(child.session_id)!
    const call: ToolCall = { id: 'failed-bash', type: 'function', function: { name: 'bash', arguments: '{}' } }
    const assistantId = running.callbacks.onAssistantMessage!('Checking build files', [call])
    running.callbacks.onToolCall!(call, assistantId)
    running.callbacks.onToolResult!(call.id, 'bash', 'exit code 1: path not found', true, 1)
    const [working] = await parent.scope.wait([child.task_id], 0)
    assert.equal(working.status, 'running'); assert.equal(working.diagnostics.tool_errors, 1)
    assert.equal(working.diagnostics.failure, undefined)
    f.finish(child.session_id, 'Used the correct path and completed validation')
    const [done] = await parent.scope.wait([child.task_id], 100)
    assert.equal(done.status, 'completed'); assert.equal(done.diagnostics.tool_errors, 1)
    assert.equal(done.diagnostics.failure, undefined)
    assert.ok(f.messages.get(child.session_id)!.some(message => message.role === 'tool' && message.status === 'error'))
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}

// Recovery reuses the original child, history, model and ownership; a broken sibling does not stop concurrency.
{
  const f = createSubagentFixture()
  try {
    const parent = await f.root(); const other = await f.root('other parent')
    const child = await parent.scope.spawn({ ...request, providerId: 'b', model: 'b-special' })
    const sibling = await parent.scope.spawn({ ...request, targetFile: 'src/independent.ts' })
    const running = f.running.get(child.session_id)!
    const call: ToolCall = { id: 'write-1', type: 'function', function: { name: 'write', arguments: '{"path":"src/parser.ts"}' } }
    const assistantId = running.callbacks.onAssistantMessage!('Writing the parser', [call])
    running.callbacks.onToolCall!(call, assistantId)
    running.callbacks.onToolResult!('write-1', 'write', 'Write completed', false, 5)
    running.reject(networkFailure())
    await turn()
    const notice = parent.options.takeCoordinationMessages!().find(item => (item.message.content as string).includes(child.task_id))!
    assert.match(notice.message.content as string, /continue_subagent/)
    const [failed] = await parent.scope.wait([child.task_id], 100)
    assert.equal(failed.status, 'failed'); assert.equal(failed.settled, true)
    assert.equal(failed.diagnostics.failure!.kind, 'network')
    assert.equal(failed.diagnostics.tools_completed, 1); assert.equal(failed.diagnostics.last_tool!.status, 'completed')
    assert.equal(failed.recovery.next_action, 'continue_subagent'); assert.equal(failed.recovery.retry_recommended, true)
    assert.equal(f.service.isRunning(sibling.session_id), true)
    await assert.rejects(other.scope.continue(child.task_id, 'foreign'), /owned/)
    const originalHistory = structuredClone(f.messages.get(child.session_id)!)
    const sessionsBefore = f.sessions.size
    f.setChildRouting([{ providerId: 'a', model: 'new-choice' }], 'spread')
    const resumed = await parent.scope.continue(child.task_id, 'Keep the parser already written; finish its focused validation.')
    assert.equal(resumed.session_id, child.session_id); assert.notEqual(resumed.task_id, child.task_id)
    assert.equal(f.sessions.size, sessionsBefore, 'continuation never creates a replacement session')
    assert.equal(resumed.diagnostics.run_number, 2); assert.equal(resumed.diagnostics.continued_from_task_id, child.task_id)
    const options = f.running.get(resumed.session_id)!.options
    assert.equal(options.provider.id, 'b'); assert.equal(options.modelOverride, 'b-special')
    assert.deepEqual(f.messages.get(child.session_id)!.slice(0, originalHistory.length), originalHistory)
    assert.ok(options.messages.some(message => message.role === 'tool' && message.tool_call_id === 'write-1'))
    assert.match(f.messages.get(child.session_id)!.at(-1)!.content, /avoid repeating commands/)
    assert.equal(resumed.targetFile, child.targetFile); assert.equal(resumed.role, child.role)
    await assert.rejects(parent.scope.continue(child.task_id, 'stale'), /Stale/)
    assert.equal((await parent.scope.wait([child.task_id], 0))[0].recovery.next_action, 'use_latest_task')
    await assert.rejects(parent.scope.spawn({ ...request, targetFile: 'src/PARSER.ts' }), /File already assigned/)
    f.running.get(resumed.session_id)!.reject(networkFailure())
    const [again] = await parent.scope.wait([resumed.task_id], 100)
    assert.equal(again.recovery.repeated_failure_kind, true); assert.equal(again.recovery.retry_recommended, false)
    assert.equal(again.recovery.next_action, 'inspect_failure')
    // Advice is not a fabricated retry/task cap: an explicit corrected continuation is still possible.
    const corrected = await parent.scope.continue(resumed.task_id, 'The network is repaired; verify the existing parser.')
    assert.equal(corrected.diagnostics.run_number, 3)
    f.finish(corrected.session_id, 'Focused validation passed'); await turn()
    const [done] = await parent.scope.wait([corrected.task_id], 100)
    assert.equal(done.recovery.next_action, 'review_result')
    assert.equal(done.diagnostics.failure, undefined)
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}

// Startup failures retain their original work order even when no child input was persisted yet.
{
  const f = createSubagentFixture()
  try {
    const parent = await f.root()
    f.delayPrompt(async () => { throw new Error('prompt preparation failed') })
    const child = await parent.scope.spawn(request)
    assert.equal(child.status, 'failed'); assert.equal(child.diagnostics.failure!.stage, 'startup')
    assert.equal(f.messages.get(child.session_id)!.length, 0)
    const size = f.sessions.size
    f.delayPrompt(async () => '')
    const resumed = await parent.scope.continue(child.task_id, 'Resume the original task.')
    assert.equal(f.sessions.size, size); assert.equal(resumed.session_id, child.session_id)
    const input = f.messages.get(child.session_id)![0].content
    assert.match(input, /ORIGINAL_GOAL/); assert.match(input, /Resume the original task/); assert.match(input, /Parser handles empty input/)
    await parent.scope.cancel(resumed.task_id)
    const cancelled = (await parent.scope.wait([resumed.task_id], 100))[0]
    assert.equal(cancelled.status, 'aborted'); assert.equal(cancelled.recovery.next_action, 'respect_cancellation')
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}

// Ended without a final event / empty final reply are diagnosable, without guessing whether prose met acceptance criteria.
for (const mode of ['no-event', 'empty', 'unfinished-report'] as const) {
  const f = createSubagentFixture()
  try {
    const parent = await f.root(); const child = await parent.scope.spawn(request)
    if (mode === 'no-event') f.running.get(child.session_id)!.resolve()
    else f.finish(child.session_id, mode === 'empty' ? '  ' : 'I stopped before running the required check.')
    const [result] = await parent.scope.wait([child.task_id], 100)
    assert.equal(result.settled, true)
    if (mode === 'unfinished-report') {
      assert.equal(result.status, 'completed'); assert.equal(result.recovery.next_action, 'review_result')
    } else {
      assert.equal(result.status, 'failed'); assert.equal(result.diagnostics.failure!.kind, 'no_deliverable')
      assert.equal(result.recovery.next_action, 'continue_subagent')
    }
    const resumed = await parent.scope.continue(child.task_id, 'Finish the remaining focused check.')
    assert.equal(resumed.session_id, child.session_id)
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}

// Retry/permission waits never advertise a dead worker or permit concurrent continuation.
{
  const f = createSubagentFixture()
  try {
    const parent = await f.root('permission owner', 'manual'); const child = await parent.scope.spawn(request)
    const callbacks = f.running.get(child.session_id)!.callbacks
    callbacks.onRetry!(1, 3, Object.assign(new Error('rate limit'), { status: 429 }))
    const retrying = parent.scope.list().tasks[0]
    assert.equal(retrying.status, 'running'); assert.equal(retrying.diagnostics.phase, 'retrying')
    assert.equal(retrying.recovery.continuation_ready, false)
    await assert.rejects(parent.scope.continue(child.task_id, 'duplicate'), /busy/)
    const permission = f.running.get(child.session_id)!.options.permissionCheck!('write', {})
    const [waiting] = await parent.scope.wait([child.task_id], 0)
    assert.equal(waiting.status, 'awaiting_permission'); assert.equal(waiting.diagnostics.phase, 'awaiting_permission')
    assert.equal(waiting.recovery.next_action, 'await_permission'); assert.equal(waiting.recovery.continuation_ready, false)
    f.permissions.respond(f.pending.at(-1)!.id, false); assert.equal(await permission, false)
    callbacks.onTruncated!('text', 'length')
    f.finish(child.session_id, 'Need parent review'); await turn()
    assert.equal(parent.scope.list().tasks[0].diagnostics.incomplete_outputs, 1)
    const allowed = parent.options.permissionCheck!('continue_subagent', { task_id: child.task_id, prompt: 'correction' })
    assert.ok(f.permissions.hasPending(parent.session.id)); f.permissions.respond(f.pending.at(-1)!.id, false)
    assert.equal(await allowed, false, 'resuming still requires the parent tool permission decision')
    f.setProviderSubagentAccess('a', false)
    const blocked = await parent.scope.continue(child.task_id, 'try')
    assert.equal(blocked.status, 'failed'); assert.equal(blocked.diagnostics.failure!.kind, 'configuration')
    assert.equal(blocked.recovery.retry_recommended, false)
    f.setProviderSubagentAccess('a', true)
    const resumed = await parent.scope.continue(blocked.task_id, 'Provider access is restored; finish the same task.')
    assert.equal(resumed.session_id, child.session_id)
    await f.service.abort(parent.session.id)
    await assert.rejects(parent.scope.continue(resumed.task_id, 'late restart'), AgentAbortedError)
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}

console.log('Subagent recovery integration: same session/history/model/file, concurrent sibling isolation, startup/empty failures, repeated failures, permissions, provider eligibility, stale IDs and abort passed')
