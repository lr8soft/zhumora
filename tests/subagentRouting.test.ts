import assert from 'node:assert/strict'
import { SubagentModelRouter, assignedSubagentProviders } from '../src/main/agent/subagentRouting.ts'
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '../src/main/store/settingsNormalization.ts'

const old = { providerId: 'a', model: 'chosen' }
const migrated = normalizeSettings({ schemaVersion: 15, subagentModel: old })
assert.equal(migrated.schemaVersion, SETTINGS_SCHEMA_VERSION)
assert.deepEqual(migrated.subagentModels, [old])
assert.equal(migrated.subagentDispatch, 'priority')
assert.equal('subagentModel' in migrated, false)
assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(migrated))).subagentModels, [old])
assert.deepEqual(normalizeSettings({ subagentModels: [], subagentModel: old }).subagentModels, [], 'explicit empty sequence wins over legacy')
for (const invalid of [null, {}, ['m'], [{ providerId: 'a', model: '' }]]) assert.throws(() => normalizeSettings({ subagentModels: invalid }))
assert.throws(() => normalizeSettings({ subagentDispatch: 'random' }))
const parent = { providerId: 'a', model: 'parent' }
const b = { providerId: 'b', model: 'b-model' }
const providers = ['a', 'b', 'c'].map(id => ({ id, name: id, baseUrl: '', apiKey: '', defaultModel: `${id}-default`, enabled: true, maxConcurrency: 1 as number | null }))
const settings = { providers, subagentModels: [old, b, { providerId: 'a', model: 'other-a' }], subagentDispatch: 'priority' as const }
const router = new SubagentModelRouter()
assert.deepEqual(router.select(settings, parent, {}), old)
assert.deepEqual(router.select(settings, parent, {}, { a: { active: 1, waiting: 0 } }), b, 'main/auxiliary occupancy influences placement')
assert.deepEqual(router.select(settings, parent, {}, {}, { a: 1 }), b, 'preparing children do not all pick the first provider')
assert.deepEqual(router.select(settings, parent, {}, {}, { a: 1, b: 1 }), old, 'all occupied keeps task creation possible; gate queues requests')
assert.deepEqual(router.select({ ...settings, providers: providers.map(p => ({ ...p, maxConcurrency: null })) }, parent, {}, {}, { a: 100 }), old, 'unlimited is not assigned a made-up capacity')
const spread = { ...settings, subagentDispatch: 'spread' as const }
assert.deepEqual([0, 1, 2, 3].map(() => router.select(spread, parent, {}).providerId), ['a', 'b', 'a', 'b'], 'providers rotate, repeated models add no weight')
assert.equal(router.select({ ...spread, subagentModels: [b, old] }, parent, {}).providerId, 'b', 'reordering resets rotation')
assert.equal(router.select(spread, parent, {}, { a: { active: 1, waiting: 0 } }).providerId, 'b')
assert.equal(router.select({ ...spread, providers: providers.map(p => ({ ...p, allowSubagents: p.id !== 'a' })) }, parent, {}).providerId, 'b')
assert.throws(() => router.select({ ...settings, subagentModels: [{ providerId: 'missing', model: 'm' }] }, parent, {}), /unknown/)
assert.throws(() => router.select({ ...settings, providers: providers.map(p => ({ ...p, enabled: false })) }, parent, {}))
assert.deepEqual(router.select({ ...settings, subagentModels: [] }, parent, {}), parent)
assert.deepEqual(router.select(settings, parent, { providerId: 'c' }), { providerId: 'c', model: 'c-default' })
assert.deepEqual(router.select(settings, parent, { providerId: 'b', model: 'explicit' }), { providerId: 'b', model: 'explicit' })
assert.deepEqual({ ...assignedSubagentProviders([{ subagentProviderId: 'a' }, {}, { subagentProviderId: 'a' }]) }, { a: 2 })
const normalized = normalizeSettings({ subagentModels: [old, b, old] })
assert.deepEqual(normalized.subagentModels, [old, b], 'deduplication preserves priority order')
console.log('Subagent sequence: migration, ordered priority, provider rotation, live occupancy, unlimited and eligibility passed')
