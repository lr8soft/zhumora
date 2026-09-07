import assert from 'node:assert/strict'
import * as THREE from 'three'
import { VRM, VRMHumanoid, VRMUtils, VRMExpression, VRMExpressionManager, type VRMHumanBones, type VRMHumanBoneName } from '@pixiv/three-vrm'
import { AvatarMotionController } from '../src/renderer/src/avatar/AvatarMotionController.ts'
import { AvatarExpressionController } from '../src/renderer/src/avatar/AvatarExpressionController.ts'
import { AvatarClipAdapter } from '../src/renderer/src/avatar/AvatarClipAdapter.ts'
import { mapScreenPointToAvatarLookTarget } from '../src/main/avatar/lookTarget.ts'
import { AVATAR_INTENTS } from '../src/shared/avatar.ts'
import { createBuiltinMotion } from '../src/renderer/src/avatar/motionClips.ts'
import { createAvatarAgentEventSink } from '../src/main/avatar/agentEvents.ts'

assert.deepEqual(mapScreenPointToAvatarLookTarget({ x: 280, y: 220 }, { x: 100, y: 100, width: 360, height: 240 }), { x: 0, y: 0 })
assert.equal(mapScreenPointToAvatarLookTarget({ x: 99, y: 100 }, { x: 100, y: 100, width: 360, height: 240 }), undefined)
assert.equal(mapScreenPointToAvatarLookTarget({ x: 460, y: 100 }, { x: 100, y: 100, width: 360, height: 240 }), undefined)

// Real VRMHumanoid conversion, including rotated authoring bones and both VRM versions.
function fixture(version: '0' | '1', authorRotation = 0) {
  const scene = new THREE.Group()
  const bones: Partial<VRMHumanBones> = {}
  const add = (name: VRMHumanBoneName, parent: VRMHumanBoneName | null, x: number, y: number) => {
    const node = new THREE.Bone()
    node.name = name
    node.position.set(x, y, 0)
    ;(parent ? bones[parent]!.node : scene).add(node)
    bones[name] = { node }
  }
  const sign = version === '0' ? -1 : 1
  add('hips', null, 0, 1)
  add('spine', 'hips', 0, 0.2)
  add('chest', 'spine', 0, 0.2)
  add('neck', 'chest', 0, 0.15)
  add('head', 'neck', 0, 0.15)
  for (const side of ['left', 'right'] as const) {
    const x = (side === 'left' ? 1 : -1) * sign
    add(`${side}UpperArm`, 'chest', x * 0.18, 0.1)
    add(`${side}LowerArm`, `${side}UpperArm`, x * 0.25, 0)
    add(`${side}Hand`, `${side}LowerArm`, x * 0.22, 0)
    add(`${side}UpperLeg`, 'hips', x * 0.1, -0.1)
    add(`${side}LowerLeg`, `${side}UpperLeg`, 0, -0.4)
    add(`${side}Foot`, `${side}LowerLeg`, 0, -0.4)
    // Authoring-axis twist around the arm keeps the world-space T-pose identical.
    bones[`${side}UpperArm`]!.node.rotation.x = authorRotation
  }
  scene.updateMatrixWorld(true)
  const humanoid = new VRMHumanoid(bones as VRMHumanBones)
  scene.add(humanoid.normalizedHumanBonesRoot)
  const vrm = new VRM({ scene, humanoid, meta: { metaVersion: version } as VRM['meta'] })
  VRMUtils.rotateVRM0(vrm)
  const mixer = new THREE.AnimationMixer(scene)
  const controller = new AvatarMotionController(vrm, mixer, async () => { throw new Error('missing') }, {}, () => 0)
  const step = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) { controller.update(1 / 60); vrm.update(1 / 60) }
    scene.updateMatrixWorld(true)
  }
  return { vrm, mixer, controller, bones, step }
}

for (const version of ['0', '1'] as const) {
  for (const authorRotation of [0, Math.PI / 3]) {
    const f = fixture(version, authorRotation)
    const idleClip = createBuiltinMotion(f.vrm, 'idle')
    for (const intent of AVATAR_INTENTS) {
      const clip = createBuiltinMotion(f.vrm, intent)
      for (const side of ['left', 'right'] as const) {
        for (const part of ['UpperArm', 'LowerArm', 'Hand'] as const) {
          const node = f.vrm.humanoid.getNormalizedBoneNode(`${side}${part}`)!
          const name = `${node.uuid}.quaternion`
          const track = clip.tracks.find(track => track.name === name)!
          const idle = idleClip.tracks.find(track => track.name === name)!
          for (let i = 0; i < track.values.length; i += 4) {
            assert.deepEqual(track.values.slice(i, i + 4), idle.values.slice(0, 4), `${intent}: arms stay relaxed`)
          }
        }
      }
    }
    await f.controller.initialize()
    f.step(0.02)
    for (const side of ['left', 'right'] as const) {
      const shoulder = f.bones[`${side}UpperArm`]!.node.getWorldPosition(new THREE.Vector3())
      const hand = f.bones[`${side}Hand`]!.node.getWorldPosition(new THREE.Vector3())
      assert.ok(hand.y < shoulder.y - 0.3, version + ': hands must hang below shoulders')
    }
    const head = f.vrm.humanoid.getNormalizedBoneNode('head')!
    const before = head.quaternion.clone()
    await f.controller.perform('greet')
    assert.ok(before.angleTo(head.quaternion) < 1e-5, 'request itself must not snap pose')
    f.step(0.15)
    const mid = head.quaternion.clone()
    await f.controller.perform('acknowledge')
    assert.ok(mid.angleTo(head.quaternion) < 1e-5, 'interrupted fade starts at displayed pose')
    f.step(4)
    const hand = f.bones.rightHand!.node.getWorldPosition(new THREE.Vector3())
    const shoulder = f.bones.rightUpperArm!.node.getWorldPosition(new THREE.Vector3())
    assert.ok(hand.y < shoulder.y - 0.3, 'one shot returns to relaxed pose')
    for (const intent of AVATAR_INTENTS) { await f.controller.perform(intent); f.step(0.6) }
    await f.controller.reset()
    f.step(16)
    assert.ok(f.mixer.stats.actions.inUse <= 2, 'finished blends must release old actions')
    f.controller.dispose()
  }
}

const expressions = new VRMExpressionManager()
for (const name of ['happy', 'Surprised', 'blink', 'lookLeft']) expressions.registerExpression(new VRMExpression(name))
const face = new AvatarExpressionController(expressions, () => 0)
face.emotion('surprised', 0.6)
face.update(0.1)
assert.ok(expressions.getValue('Surprised')! > 0 && expressions.getValue('Surprised')! < 0.45)
face.emotion('happy', 0.6)
for (let i = 0; i < 30; i++) face.update(1 / 60)
assert.equal(expressions.getValue('Surprised'), 0, 'old emotion fades out')
for (let i = 0; i < 300; i++) face.update(1 / 60)
assert.equal(expressions.getValue('happy'), 0, 'emotion expires without LLM reset')
assert.throws(() => face.expression('nonexistent', 1), /Unknown/)

const sessionStates = new Map<string, string>()
const sink = createAvatarAgentEventSink({
  setMessage() {},
  setActivity(sessionId, activity) { sessionStates.set(sessionId, activity) }
})
sink.assistantStart!('a', 'm1')
sink.token!('b', 'm2', 'hello')
sink.complete!('a', 'm1', 'done')
assert.equal(sessionStates.get('a'), 'idle')
assert.equal(sessionStates.get('b'), 'speaking', 'one session finishing must not stop another Avatar')
sink.error!('b', new Error('failed'))
assert.equal(sessionStates.get('b'), 'idle')

const sparse = fixture('1')
const adapter = new AvatarClipAdapter(sparse.vrm)
const headNode = sparse.vrm.humanoid.getNormalizedBoneNode('head')!
const headClip = new THREE.AnimationClip('head-only', 2, [new THREE.QuaternionKeyframeTrack(
  headNode.name + '.quaternion', [0, 2], [0, 0, 0, 1, 0, 0.1, 0, Math.sqrt(0.99)]
)])
const completed = adapter.adapt(headClip)
assert.ok(completed.tracks.some(track => track.name === sparse.vrm.humanoid.getNormalizedBoneNode('leftUpperArm')!.uuid + '.quaternion'))
assert.equal(headClip.tracks.length, 1, 'normalization must not mutate cached source clips')
assert.throws(() => adapter.adapt(new THREE.AnimationClip('empty', 0, [])), /no playable/)
sparse.controller.dispose()

const race = fixture('1')
let resolveClip!: (clip: THREE.AnimationClip) => void
const pendingClip = new Promise<THREE.AnimationClip>(resolve => { resolveClip = resolve })
const raceMotion = new AvatarMotionController(race.vrm, race.mixer, () => pendingClip)
await raceMotion.initialize()
const pendingPlay = raceMotion.play('slow', false)
await raceMotion.reset()
resolveClip(completed)
await assert.rejects(pendingPlay, /superseded/, 'late asset loading cannot override a newer reset')
raceMotion.dispose()
assert.equal(race.mixer.stats.actions.inUse, 0, 'dispose stops all actions')

console.log('avatar motion, rig compatibility, transitions and expression tests passed')
