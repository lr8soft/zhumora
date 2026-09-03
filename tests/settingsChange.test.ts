import assert from 'node:assert/strict'
import { equivalentConfigList } from '../src/main/ipc/settingsChange.ts'

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
console.log('settings semantic comparison tests passed')
