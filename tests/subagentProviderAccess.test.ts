import assert from 'node:assert/strict'
import { createSubagentFixture } from './helpers/subagentFixture.ts'
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '../src/main/store/settingsNormalization.ts'
import { normalizeProviderSubagentAccess } from '../src/shared/providerSubagents.ts'
import { validateProviderRequest } from '../src/shared/providerHeaders.ts'
import { SubagentModelRouter } from '../src/main/agent/subagentRouting.ts'
import { buildSubagentModelOptions } from '../src/renderer/src/subagentModelOptions.ts'
import { executeToolCall } from '../src/main/agent/toolExecutor.ts'

const provider = { id: 'p', name: 'P', baseUrl: 'https://test.example', apiKey: '', enabled: true, defaultModel: 'm' }
const request = { description: 'small change', prompt: 'Inspect the assigned module.' }
const blocked = /does not allow subagents/
assert.equal(normalizeSettings(null).providers[0].allowSubagents, true)
const legacy = normalizeSettings({ schemaVersion: 14, providers: [provider] })
assert.equal(legacy.schemaVersion, SETTINGS_SCHEMA_VERSION)
assert.equal(legacy.providers[0].allowSubagents, true)
const saved = normalizeSettings({ ...legacy, providers: [{ ...provider, allowSubagents: false }] })
assert.equal(normalizeSettings(JSON.parse(JSON.stringify(saved))).providers[0].allowSubagents, false)
for (const invalid of [null, 0, 1, 'false', {}, []]) {
  assert.throws(() => normalizeProviderSubagentAccess(invalid), /boolean/)
  assert.throws(() => normalizeSettings({ providers: [{ ...provider, allowSubagents: invalid }] }), /boolean/)
  assert.throws(() => validateProviderRequest({ ...provider, allowSubagents: invalid }), /boolean/)
}
assert.equal(validateProviderRequest(provider).allowSubagents, true)
assert.equal(validateProviderRequest(saved.providers[0]).allowSubagents, false)
const parentModel = { providerId: 'p', model: 'm' }
for (const [input, selection] of [[request, null], [{ ...request, providerId: 'p' }, null], [request, parentModel]] as const) {
  assert.throws(() => new SubagentModelRouter().select({ ...saved, subagentModels: selection ? [selection] : [] }, parentModel, input), blocked)
}
assert.deepEqual(buildSubagentModelOptions(saved.providers, { p: [{ id: 'm' }] }, []), [])
const options = buildSubagentModelOptions(saved.providers, { p: [{ id: 'm' }] }, [parentModel])
assert.equal(options.length, 1); assert.equal(options[0].unavailable, true, 'saved choice remains visible but cannot be selected')

// Saved access applies to cached parent scopes and explicit overrides, without changing the main model.
{
  const f = createSubagentFixture()
  try {
    f.setProviderSubagentAccess('a', false)
    const parent = await f.root()
    assert.equal(parent.options.provider.id, 'a')
    const sessionCount = f.sessions.size
    await assert.rejects(parent.scope.spawn(request), blocked)
    await assert.rejects(parent.scope.spawn({ ...request, providerId: 'a', model: 'override' }), blocked)
    assert.equal(f.sessions.size, sessionCount, 'blocked spawn must not create a child session')
    assert.deepEqual(f.service.listSubagentProviders().map(p => p.id), ['b'])
    assert.doesNotMatch(parent.options.systemPromptExtra!, /"providerId":"a"/)
    f.setChildModel({ providerId: 'b', model: 'cheap-model' })
    const child = await parent.scope.spawn(request)
    assert.equal(f.running.get(child.session_id)!.options.provider.id, 'b')
    f.setProviderSubagentAccess('b', false)
    assert.equal(f.service.isRunning(child.session_id), true, 'in-flight child can complete normally')
    assert.equal((await parent.scope.wait([child.task_id], 0))[0].status, 'running')
    f.finish(child.session_id); await parent.scope.wait([child.task_id])
    const before = f.messages.get(child.session_id)!.length
    const continued = await parent.scope.continue(child.task_id, 'follow-up')
    assert.equal(continued.status, 'failed'); assert.match(continued.error!, blocked)
    assert.equal(f.messages.get(child.session_id)!.length, before)
    assert.deepEqual(f.service.listSubagentProviders(), [])
    f.finish(parent.session.id); await parent.handle.completion
    await assert.rejects(f.service.sendMessage({ sessionId: child.session_id, message: { text: 'manual continuation' } }), blocked)
    await assert.rejects(f.service.compact(child.session_id), blocked)
    assert.equal(f.messages.get(child.session_id)!.length, before, 'opening a child directly cannot bypass provider access')
    f.setProviderSubagentAccess('b', true)
    const resumed = await f.service.sendMessage({ sessionId: child.session_id, message: { text: 'now allowed' } })
    f.finish(child.session_id); await resumed.completion
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}

// A setting saved during asynchronous prompt preparation blocks persistence and executor startup.
{
  const f = createSubagentFixture()
  try {
    const parent = await f.root(); let release!: (value: string) => void
    f.delayPrompt(() => new Promise(resolve => { release = resolve }))
    const starting = parent.scope.spawn(request)
    await Promise.resolve()
    f.setProviderSubagentAccess('a', false); release('ready')
    const child = await starting
    assert.equal(child.status, 'failed'); assert.match(child.error!, blocked)
    assert.equal(f.messages.get(child.session_id)!.length, 0)
    assert.equal(f.running.has(child.session_id), false)
    assert.equal(f.service.isRunning(child.session_id), false)
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}

// Permission granted after a setting change cannot start a forbidden child; retain a legal tool result.
{
  const f = createSubagentFixture()
  try {
    const parent = await f.root('late approval', 'manual')
    const call = { id: 'spawn', type: 'function' as const, function: { name: 'spawn_subagent', arguments: JSON.stringify(request) } }
    const executing = executeToolCall({ toolCall: call, registry: f.tools,
      context: { workspacePath: 'D:/shared', sessionId: parent.session.id, signal: parent.options.signal },
      permissionCheck: parent.options.permissionCheck })
    await Promise.resolve()
    f.setProviderSubagentAccess('a', false)
    f.permissions.respond(f.pending.at(-1)!.id, true)
    const result = await executing
    assert.equal(result.isError, true)
    assert.equal(result.llmMessage.tool_call_id, call.id)
    assert.match(JSON.stringify(result), blocked)
    assert.equal(f.sessions.size, 1)
    assert.equal(f.running.size, 1)
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}
console.log('Subagent provider access: migration, routing, UI choices, live preparation, continuation and late approval passed')
