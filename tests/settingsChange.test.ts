import assert from 'node:assert/strict'
import { equivalentConfigList } from '../src/main/ipc/settingsChange.ts'
import { equivalentTelegramBotConfig, normalizeTelegramBotConfig, parseTelegramUserIds } from '../src/shared/telegram.ts'
import { equivalentQQBotConfig, normalizeQQBotConfig, parseQQUserIds } from '../src/shared/qq.ts'
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '../src/main/store/settingsNormalization.ts'
import { buildSubagentModelOptions } from '../src/renderer/src/subagentModelOptions.ts'

const first = [
  { id: 'b', name: 'B', enabled: true, env: { Z: '2', A: '1' } },
  { id: 'a', name: 'A', enabled: false, env: {} }
]
const reordered = [
  { env: {}, enabled: false, name: 'A', id: 'a' },
  { env: { A: '1', Z: '2' }, enabled: true, name: 'B', id: 'b' }
]

assert.equal(equivalentConfigList(first, reordered), true)
assert.equal(equivalentConfigList(first, [{ ...first[0], enabled: false }, first[1]]), false)
assert.deepEqual(parseTelegramUserIds('123\n456, 123 invalid -1'), ['123', '456'])
assert.deepEqual(normalizeTelegramBotConfig({ enabled: 1, token: ' token ', allowedUserIds: ['123', 456, '123'] }), {
  enabled: false,
  token: 'token',
  allowedUserIds: ['123'],
  approveMode: 'manual'
})
assert.equal(equivalentTelegramBotConfig(
  { enabled: true, token: 'token', allowedUserIds: ['123', '456'], approveMode: 'auto' },
  { enabled: true, token: 'token', allowedUserIds: ['456', '123'], approveMode: 'auto' }
), true)
assert.equal(equivalentTelegramBotConfig(
  { enabled: true, token: 'token', allowedUserIds: [], approveMode: 'manual' },
  { enabled: true, token: 'token', allowedUserIds: [], approveMode: 'full' }
), false)
assert.deepEqual(parseQQUserIds('openid-a\nopenid_b, openid-a'), ['openid-a', 'openid_b'])
assert.deepEqual(normalizeQQBotConfig({
  enabled: true,
  appId: ' 123 ',
  appSecret: ' secret ',
  allowedUserIds: ['openid-a', 123, 'openid-a'],
  approveMode: 'auto'
}), {
  enabled: true,
  appId: '123',
  appSecret: 'secret',
  allowedUserIds: ['openid-a'],
  approveMode: 'auto'
})
assert.equal(equivalentQQBotConfig(
  { enabled: true, appId: '1', appSecret: 's', allowedUserIds: ['a', 'b'], approveMode: 'full' },
  { enabled: true, appId: '1', appSecret: 's', allowedUserIds: ['b', 'a'], approveMode: 'full' }
), true)
const migrated = normalizeSettings({ schemaVersion: 11, workspacePath: 'D:/kept', maxRounds: 12 }, 'D:/default')
assert.equal(migrated.schemaVersion, SETTINGS_SCHEMA_VERSION)
assert.equal(migrated.subagentsEnabled, true, 'legacy settings retain previously enabled delegation')
assert.equal(migrated.workspacePath, 'D:/kept'); assert.equal(migrated.maxRounds, 12)
assert.equal(migrated.subagentModel, null)
const disabled = normalizeSettings({ ...migrated, subagentsEnabled: false })
assert.equal(disabled.subagentsEnabled, false)
assert.equal(normalizeSettings(JSON.parse(JSON.stringify(disabled))).subagentsEnabled, false, 'the saved switch survives JSON reload')
for (const malformed of ['false', 1, null, {}]) assert.equal(normalizeSettings({ subagentsEnabled: malformed }).subagentsEnabled, false)
assert.equal(normalizeSettings(null).subagentsEnabled, true)
const parentBeforeChoice = normalizeSettings(migrated)
const chosen = normalizeSettings({ ...parentBeforeChoice, subagentModel: { providerId: ' child-provider ', model: ' child-model ' } })
assert.deepEqual(chosen.subagentModel, { providerId: 'child-provider', model: 'child-model' })
assert.equal(chosen.activeProviderId, parentBeforeChoice.activeProviderId)
assert.deepEqual(chosen.providers, parentBeforeChoice.providers, 'selecting the child default leaves parent provider/model unchanged')
assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(chosen))).subagentModel, chosen.subagentModel)
assert.deepEqual(normalizeSettings({ ...chosen, subagentsEnabled: false }).subagentModel, chosen.subagentModel, 'off retains the selected child model')
for (const malformed of ['model', {}, { providerId: '', model: 'm' }, { providerId: 'p', model: 1 }]) {
  assert.equal(normalizeSettings({ subagentModel: malformed }).subagentModel, null)
}
const options = buildSubagentModelOptions(chosen.providers, { 'zhuminet-default': [{ id: 'remote-model' }, { id: 'remote-model' }] }, chosen.subagentModel)
assert.equal(options.filter(option => option.model === 'remote-model').length, 1)
assert.ok(options.find(option => option.providerId === 'child-provider')?.unavailable, 'removed providers retain a visible saved choice')

console.log('settings semantic comparison, child model selection and normalization tests passed')
