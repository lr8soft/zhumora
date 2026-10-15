import assert from 'node:assert/strict'
import { createSubagentFixture } from './helpers/subagentFixture.ts'

const models = [{ providerId: 'a', model: 'a-worker' }, { providerId: 'b', model: 'b-worker' }]
const request = { description: 'focused work', prompt: 'Inspect one module', role: 'explorer' as const }
{
  const f = createSubagentFixture()
  f.setChildRouting(models, 'priority'); f.setProviderConcurrency('a', 1); f.setProviderConcurrency('b', 1)
  const first = await f.root('first'); const second = await f.root('second')
  let finishPreparation!: () => void; let preparations = 0
  f.delayPrompt(async () => { if (preparations++ === 0) await new Promise<void>(resolve => { finishPreparation = resolve }); return '' })
  const preparing = first.scope.spawn(request)
  const b = await second.scope.spawn(request)
  assert.equal(b.providerId, 'b', 'another parent sees the first child during preparation, before its HTTP request')
  finishPreparation()
  const a = await preparing
  assert.equal(a.providerId, 'a')
  const queued = await second.scope.spawn(request)
  assert.equal(queued.providerId, 'a', 'all full still creates a child whose requests can queue')
  f.finish(a.session_id, 'first result')
  await first.scope.wait([a.task_id])
  f.setChildRouting([...models].reverse(), 'spread')
  const continued = await first.scope.continue(a.task_id, 'Check the same module again')
  assert.equal(continued.session_id, a.session_id)
  assert.notEqual(continued.task_id, a.task_id)
  assert.equal(continued.providerId, 'a'); assert.equal(continued.model, 'a-worker')
  assert.ok(f.running.get(continued.session_id)!.options.messages.some(item => item.content === 'first result'))
  f.setProviderSubagentAccess('a', false)
  f.finish(continued.session_id)
  await first.scope.wait([continued.task_id])
  const forbidden = await first.scope.continue(continued.task_id, 'again')
  assert.equal(forbidden.status, 'failed', 'continuation does not switch providers when original access is revoked')
  await f.service.stopAll(); f.permissions.dispose()
}
{
  const f = createSubagentFixture()
  f.setChildRouting(models, 'spread')
  const first = await f.root(); const second = await f.root('second')
  const tasks = await Promise.all([first.scope.spawn(request), second.scope.spawn(request), first.scope.spawn(request), second.scope.spawn(request)])
  assert.deepEqual(tasks.map(task => task.providerId), ['a', 'b', 'a', 'b'], 'rotation is shared by parent sessions')
  f.setChildRouting([...models].reverse(), 'priority')
  assert.equal((await first.scope.spawn(request)).providerId, 'b', 'new dispatches read saved order immediately')
  f.setProviderSubagentAccess('b', false)
  assert.equal((await second.scope.spawn(request)).providerId, 'a', 'forbidden entries are skipped for new tasks')
  await f.service.stopAll(); f.permissions.dispose()
}
console.log('Subagent dispatch: cross-session placement, delayed preparation, full queues, rotation, settings changes and continuation identity passed')
