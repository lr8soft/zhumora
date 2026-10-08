import assert from 'node:assert/strict'
import { validateSessionModelSelection, type SessionModelSelection } from '../src/shared/sessionModel.ts'
import { resolveSessionModel } from '../src/main/agent/sessionModelPolicy.ts'
import { createSessionModelSlice, sessionModelSelection } from '../src/renderer/src/store/sessionModelSlice.ts'
import { createSubagentFixture } from './helpers/subagentFixture.ts'
import type { AppSettings } from '../src/shared/types.ts'

const qwen = { providerId: 'a', model: 'qwen3.8 27b' }
const deepseek = { providerId: 'b', model: 'deepseek v4.1 flash' }
for (const value of [undefined, '', [], {}, { providerId: 'a', model: '' }, { providerId: 1, model: 'x' }]) {
  assert.throws(() => validateSessionModelSelection(value), /Invalid/)
}
assert.deepEqual(validateSessionModelSelection(qwen), qwen)
assert.notEqual(validateSessionModelSelection(qwen), qwen, 'boundary returns a copy')

// Save before sending; concurrent runs use their own remembered model. In-flight changes
// affect the next run, and compaction uses the same selection as sending.
{
  const f = createSubagentFixture()
  const a = f.service.createSession('one'); const b = f.service.createSession('two')
  f.service.updateModelSelection(a.id, qwen)
  f.service.updateModelSelection(b.id, deepseek)
  assert.deepEqual(f.service.listSessions().map(session => session.modelSelection), [qwen, deepseek])
  const first = await f.service.sendMessage({ sessionId: a.id, message: { text: 'hello' } })
  const second = await f.service.sendMessage({ sessionId: b.id, message: { text: 'hello' }, inputSource: 'external' })
  assert.equal(f.running.get(a.id)!.options.provider.id, 'a')
  assert.equal(f.running.get(a.id)!.options.modelOverride, qwen.model)
  assert.equal(f.running.get(b.id)!.options.provider.id, 'b')
  assert.equal(f.running.get(b.id)!.options.modelOverride, deepseek.model)
  f.service.updateModelSelection(a.id, deepseek)
  assert.equal(f.running.get(a.id)!.options.modelOverride, qwen.model, 'running model is a snapshot')
  f.finish(a.id); f.finish(b.id); await Promise.all([first.completion, second.completion])
  const next = await f.service.sendMessage({ sessionId: a.id, message: { text: 'next' } })
  assert.equal(f.running.get(a.id)!.options.provider.id, 'b')
  assert.equal(f.running.get(a.id)!.options.modelOverride, deepseek.model)
  f.finish(a.id); await next.completion
  await f.service.compact(a.id)
  assert.deepEqual(f.compactModels.at(-1), { providerId: 'b', model: deepseek.model })
  f.service.updateModelSelection(a.id, null)
  const defaults = await f.service.sendMessage({ sessionId: a.id, message: { text: 'default' } })
  assert.equal(f.running.get(a.id)!.options.provider.id, 'a')
  assert.equal(f.running.get(a.id)!.options.modelOverride, undefined)
  f.finish(a.id); await defaults.completion
  assert.deepEqual(f.service.getSession(b.id)!.modelSelection, deepseek, 'reset is isolated')
  assert.throws(() => f.service.updateModelSelection('missing', qwen), /not found/)
  assert.throws(() => f.service.updateModelSelection(a.id, { providerId: 'off', model: 'x' }), /disabled/)
  assert.throws(() => f.service.updateModelSelection(a.id, { providerId: 'missing', model: 'x' }), /provider/)
  assert.throws(() => f.service.updateModelSelection(a.id, {}), /Invalid/)
  const settings = { providers: f.service.listSubagentProviders().map(provider => ({ ...provider, enabled: true })), activeProviderId: 'a' } as AppSettings
  assert.equal(resolveSessionModel(settings, f.service.getSession(b.id)!, { providerId: 'a' }).modelOverride, undefined)
  assert.equal(resolveSessionModel(settings, f.service.getSession(b.id)!, { modelOverride: 'override' }).modelOverride, 'override')
  settings.providers = settings.providers.filter(provider => provider.id !== 'b')
  assert.throws(() => resolveSessionModel(settings, f.service.getSession(b.id)!), /provider/, 'removed endpoint cannot silently fall back')
  await f.service.stopAll(); f.permissions.dispose()
}

// Renderer projection: switch conversations while saving, rapid choices, failures and deletion.
{
  const f = createSubagentFixture()
  const a = f.service.createSession('one'); const b = f.service.createSession('two')
  let state = { sessions: [a, b] }
  const requests: { id: string; selection: SessionModelSelection | null; resolve: () => void; reject: () => void }[] = []
  const slice = createSessionModelSlice(update => { state = { ...state, ...update(state) } },
    (id, selection) => new Promise((resolve, reject) => {
      requests.push({ id, selection, resolve: () => resolve(selection), reject: () => reject(new Error('save failed')) })
    }))
  const first = slice.setSessionModelSelection(a.id, qwen)
  const newer = slice.setSessionModelSelection(a.id, deepseek)
  const other = slice.setSessionModelSelection(b.id, qwen)
  let ready = false
  const barrier = slice.waitForSessionModelSelection(a.id).then(() => { ready = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests.map(request => request.id), [a.id, b.id], 'different sessions save independently')
  requests[1].resolve(); await other
  assert.deepEqual(sessionModelSelection(state.sessions.find(session => session.id === b.id)), qwen)
  assert.equal(ready, false)
  requests[0].resolve(); await first
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ready, false, 'sending waits for the newest queued choice')
  requests[2].resolve(); await newer; await barrier
  assert.deepEqual(sessionModelSelection(state.sessions.find(session => session.id === a.id)), deepseek)
  assert.deepEqual(sessionModelSelection(state.sessions.find(session => session.id === b.id)), qwen)
  const restored = JSON.parse(JSON.stringify(state.sessions))
  assert.deepEqual(sessionModelSelection(restored[0]), deepseek, 'reload restores each session projection')
  const failed = slice.setSessionModelSelection(a.id, null)
  const failedCheck = assert.rejects(failed, /save failed/)
  await new Promise(resolve => setImmediate(resolve))
  requests[3].reject(); await failedCheck
  assert.deepEqual(sessionModelSelection(state.sessions[0]), deepseek, 'failed saves leave the confirmed value intact')
  const reset = slice.setSessionModelSelection(a.id, null)
  await new Promise(resolve => setImmediate(resolve))
  requests[4].resolve(); await reset
  assert.equal(sessionModelSelection(state.sessions[0]), null)
  const deleting = slice.setSessionModelSelection(b.id, deepseek)
  state = { sessions: state.sessions.filter(session => session.id !== b.id) }
  await new Promise(resolve => setImmediate(resolve))
  requests[5].resolve(); await deleting
  assert.equal(state.sessions.length, 1, 'late saves cannot recreate deleted sessions')
  f.permissions.dispose()
}

console.log('Per-session model persistence, routing and renderer save ordering tests passed')
