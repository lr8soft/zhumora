import assert from 'node:assert/strict'
import {
  equivalentAvatarModel,
  normalizeAvatarLine,
  normalizeAvatarModels,
  resolveStartupAvatarAnimation,
  resolveDefaultAvatarModelId
} from '../src/shared/avatar.ts'

const models = normalizeAvatarModels([
  {
    id: 'model-1',
    name: ' Miku ',
    filePath: 'D:/avatars/miku.vrm',
    defaultAnimationId: 'dance',
    animations: [
      { id: 'wave', name: ' Wave ', source: 'embedded', clipName: 'Armature|Wave' },
      { id: 'dance', name: 'Dance', source: 'vrma', filePath: 'D:/avatars/dance.vrma' },
      { id: 'broken', name: 'Broken', source: 'vrma' }
    ]
  },
  { id: 'model-1', name: 'Duplicate', filePath: 'D:/duplicate.vrm' },
  { id: '', name: 'Invalid', filePath: 'D:/invalid.vrm' }
])

assert.equal(models.length, 1)
assert.equal(models[0].name, 'Miku')
assert.equal(models[0].defaultAnimationId, 'dance')
assert.deepEqual(models[0].animations, [
  { id: 'wave', name: 'Wave', source: 'embedded', clipName: 'Armature|Wave', filePath: undefined },
  { id: 'dance', name: 'Dance', source: 'vrma', clipName: undefined, filePath: 'D:/avatars/dance.vrma' }
])
assert.equal(resolveDefaultAvatarModelId(models, 'model-1'), 'model-1')
assert.equal(resolveDefaultAvatarModelId(models, 'missing'), 'model-1')
assert.equal(resolveDefaultAvatarModelId([], 'missing'), null)
assert.equal(normalizeAvatarLine('  hello\n\tworld  '), 'hello world')
assert.equal(equivalentAvatarModel(models[0], {
  ...models[0],
  animations: [...models[0].animations].reverse()
}), true)
assert.equal(equivalentAvatarModel(models[0], { ...models[0], name: 'Other' }), false)
assert.equal(equivalentAvatarModel(models[0], { ...models[0], defaultAnimationId: 'wave' }), false)
assert.equal(resolveStartupAvatarAnimation(models[0], ['Wave', 'Dance']), 'Dance')
assert.equal(resolveStartupAvatarAnimation({ animations: [] }, ['Blink', 'calm_idle_loop']), 'calm_idle_loop')
assert.equal(resolveStartupAvatarAnimation({ animations: [] }, ['Wave']), undefined)

console.log('avatar config tests passed')
