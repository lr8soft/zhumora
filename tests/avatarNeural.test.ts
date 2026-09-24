import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { VRM, VRMHumanoid, VRMUtils, type VRMHumanBones, type VRMHumanBoneName } from '@pixiv/three-vrm'
import { generateMotion, hashMotionText, prepareMotionModel, routeMotion, type MotionModelData } from '../src/renderer/src/avatar/neural/inference.ts'
import { createNeuralClip } from '../src/renderer/src/avatar/neural/createNeuralClip.ts'
import { AvatarMotionController } from '../src/renderer/src/avatar/AvatarMotionController.ts'
import { trainedAvatarIntents } from '../src/shared/avatar.ts'

const model = prepareMotionModel(JSON.parse(readFileSync(new URL('../src/renderer/src/avatar/neural/motion-model.json', import.meta.url), 'utf8')) as MotionModelData)
assert.equal(model.version, 1)
assert.equal(model.classes.length, 12)
assert.ok(model.bones.length >= 50)
assert.equal(hashMotionText('挥手').length, model.text.input)
assert.deepEqual([...hashMotionText('挥手')].flatMap((value, index) => value > 0 ? [index] : []), [30, 225, 424],
  'runtime text hashing stays aligned with the Python trainer')

for (const [prompt, expected] of [
  ['挥手', 'wave'], ['请向用户挥手', 'wave'], ['打招呼', 'greet'],
  ['喝水', 'drink'], ['看手机', 'phone'], ['庆祝', 'celebrate'],
  ['wave goodbye', 'wave'], ['point to the screen', 'point'], ['spin around', 'spin']
]) {
  const index = routeMotion(model, prompt)
  assert.notEqual(index, null, prompt)
  assert.equal(model.classes[index!].name, expected, prompt)
}
assert.equal(routeMotion(model, '火星飞船跳舞'), null)
assert.equal(routeMotion(model, '   '), null)
assert.equal(routeMotion(model, '挥手'.repeat(100)), null)

const generated = generateMotion(model, '挥手')!
assert.equal(generated.name, 'wave')
assert.equal(generated.rotations.length, generated.frames * generated.bones.length * 4)
for (let index = 0; index < generated.rotations.length; index += 4) {
  const length = Math.hypot(...generated.rotations.slice(index, index + 4))
  assert.ok(Number.isFinite(length) && Math.abs(length - 1) < 1e-4)
}

function fixture(version: '0' | '1'): VRM {
  const scene = new THREE.Scene()
  const bones: Partial<VRMHumanBones> = {}
  let previous: THREE.Object3D = scene
  for (const name of model.bones) {
    const node = new THREE.Bone()
    node.name = name
    previous.add(node)
    bones[name as VRMHumanBoneName] = { node }
    previous = node
  }
  const humanoid = new VRMHumanoid(bones as VRMHumanBones)
  scene.add(humanoid.normalizedHumanBonesRoot)
  const vrm = new VRM({ scene, humanoid, meta: { metaVersion: version } as VRM['meta'] })
  VRMUtils.rotateVRM0(vrm)
  return vrm
}

for (const version of ['0', '1'] as const) {
  const vrm = fixture(version)
  const clip = createNeuralClip(vrm, generated, 0.8)
  assert.equal(clip.duration, generated.duration)
  assert.ok(clip.tracks.length >= 45)
  for (const track of clip.tracks) {
    assert.ok(track.name.endsWith('.quaternion'))
    assert.equal(track.times.length, generated.frames)
    for (const value of track.values) assert.ok(Number.isFinite(value))
  }
  const mixer = new THREE.AnimationMixer(vrm.scene)
  const arm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm')!
  const before = arm.quaternion.clone()
  mixer.clipAction(clip).play()
  mixer.update(clip.duration / 2)
  vrm.update(clip.duration / 2)
  assert.ok(Number.isFinite(vrm.humanoid.getNormalizedBoneNode('head')!.quaternion.w))
  assert.ok(before.angleTo(arm.quaternion) > 0.02, 'generated clip animates the target VRM')
}

const runtimeVrm = fixture('1')
const runtimeMixer = new THREE.AnimationMixer(runtimeVrm.scene)
const trained = trainedAvatarIntents(model.classes.map(entry => entry.name))
assert.deepEqual(trained, ['idle', 'greet', 'celebrate', 'wave', 'bow'],
  'only intents present in the trained vocabulary may replace a built-in motion')
const routed: string[] = []
const controller = new AvatarMotionController(runtimeVrm, runtimeMixer, async () => { throw new Error('missing') }, {}, () => 0, {
  intents: new Set(trained),
  generate: async (text, intensity) => {
    routed.push(text)
    const motion = generateMotion(model, text)
    return motion ? createNeuralClip(runtimeVrm, motion, intensity) : null
  }
})
assert.deepEqual(await controller.initialize(), { name: 'idle', builtIn: false })
assert.deepEqual(routed, ['idle'])
await controller.perform('wave')
controller.update(0.1)
for (const intent of ['acknowledge', 'disagree', 'shrug', 'applaud', 'sad'] as const) await controller.perform(intent)
assert.deepEqual(routed, ['idle', 'wave'], 'untrained intents must keep the built-in motion')
await controller.generateFromText('喝水')
controller.update(0.1)
assert.ok(routed.includes('喝水'), 'free text still reaches the model in any trained action')
await assert.rejects(controller.generateFromText('火星飞船跳舞'), /outside the local motion model vocabulary/)
controller.dispose()

console.log('avatar CPU text motion model and VRM0/1 clip tests passed')
