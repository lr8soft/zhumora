import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { normalizeAvatarWindowSize, fitAvatarBounds } from '../src/shared/avatarWindow.ts'
import { AvatarWindowInteraction } from '../src/main/avatar/windowInteraction.ts'

assert.deepEqual(normalizeAvatarWindowSize(undefined), { width: 360, height: 540 })
assert.deepEqual(normalizeAvatarWindowSize({ width: NaN, height: Infinity }), { width: 360, height: 540 })
assert.deepEqual(normalizeAvatarWindowSize({ width: 1, height: 9000 }), { width: 240, height: 1440 })
assert.deepEqual(normalizeAvatarWindowSize({ width: 400.4, height: 600.7 }), { width: 400, height: 601 })
assert.deepEqual(fitAvatarBounds({ x: -20, y: 900, width: 360, height: 540 },
  { x: -1920, y: 0, width: 1920, height: 1080 }), { x: -360, y: 540, width: 360, height: 540 })

function interactionFixture() {
  const window = Object.assign(new EventEmitter(), {
    bounds: { x: 100, y: 100, width: 360, height: 540 }, ignore: true,
    getBounds() { return { ...this.bounds } },
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds },
    setIgnoreMouseEvents(ignore: boolean) { this.ignore = ignore },
    isDestroyed() { return false }
  })
  const pointer = { x: 200, y: 200 }
  const interaction = new AvatarWindowInteraction(window as unknown as ConstructorParameters<typeof AvatarWindowInteraction>[0], {
    cursor: () => ({ ...pointer }), workArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 })
  })
  return { window, pointer, interaction }
}
const a = interactionFixture(), b = interactionFixture()
a.interaction.drag('start')
a.interaction.setPassthrough(true)
assert.equal(a.window.ignore, false, 'drag cannot lose mouse capture to hover')
a.pointer.x += 50
a.interaction.drag('move')
assert.equal(a.window.bounds.x, 150)
a.pointer.x += 20
a.interaction.drag('move')
assert.equal(a.window.bounds.x, 170, 'delta uses original window origin')
assert.equal(b.window.bounds.x, 100, 'sessions have independent drag state')
a.window.emit('blur')
assert.equal(a.window.ignore, true)
a.pointer.x += 20
a.interaction.drag('move')
assert.equal(a.window.bounds.x, 170, 'blur cancels dragging')
a.interaction.drag('start')
a.interaction.drag('end')
assert.equal(a.window.ignore, true)
a.interaction.resize({ width: 960, height: 1440 })
assert.equal(a.window.bounds.height, 1080, 'window fits available desktop')
a.interaction.dispose()
b.interaction.dispose()
assert.equal(a.window.listenerCount('blur'), 0)
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

const mapped = normalizeAvatarModels([{ ...models[0], animations: [{ ...models[0].animations[0], intent: 'greet' }] }])[0]
assert.equal(mapped.animations[0].intent, 'greet')
assert.equal(equivalentAvatarModel(mapped, { ...mapped, animations: [{ ...mapped.animations[0], intent: 'explain' }] }), false)
assert.equal(normalizeAvatarModels([{ ...models[0], animations: [{ ...models[0].animations[0], intent: 'invalid' }] }])[0].animations[0].intent, undefined)

console.log('avatar config tests passed')
