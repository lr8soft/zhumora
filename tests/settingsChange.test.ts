import assert from 'node:assert/strict'
import { equivalentConfigList } from '../src/main/ipc/settingsChange.ts'
import { equivalentTelegramBotConfig, normalizeTelegramBotConfig, parseTelegramUserIds } from '../src/shared/telegram.ts'

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
console.log('settings semantic comparison tests passed')
