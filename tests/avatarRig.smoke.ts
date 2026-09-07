// Optional read-only smoke check: node tests/avatarRig.smoke.ts <model.vrm> [...]
// Reconstructs authoring bones without textures/WebGL, exercising real rig data.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import * as THREE from 'three'
import { VRM, VRMHumanoid, VRMUtils, type VRMHumanBones } from '@pixiv/three-vrm'
import { AvatarMotionController } from '../src/renderer/src/avatar/AvatarMotionController.ts'

for (const path of process.argv.slice(2)) {
  const bytes = await readFile(path)
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'expected GLB')
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'))
  const nodes: THREE.Object3D[] = json.nodes.map((data: { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }) => {
    const node = new THREE.Bone()
    if (data.matrix) new THREE.Matrix4().fromArray(data.matrix).decompose(node.position, node.quaternion, node.scale)
    else {
      if (data.translation) node.position.fromArray(data.translation)
      if (data.rotation) node.quaternion.fromArray(data.rotation)
      if (data.scale) node.scale.fromArray(data.scale)
    }
    return node
  })
  json.nodes.forEach((data: { children?: number[] }, index: number) => data.children?.forEach(child => nodes[index].add(nodes[child])))
  const scene = new THREE.Group()
  for (const index of json.scenes[json.scene ?? 0].nodes) scene.add(nodes[index])
  scene.updateMatrixWorld(true)
  const version = json.extensions.VRMC_vrm ? '1' : '0'
  const entries: [string, { node: number }][] = version === '1'
    ? Object.entries(json.extensions.VRMC_vrm.humanoid.humanBones)
    : json.extensions.VRM.humanoid.humanBones.map((bone: { bone: string; node: number }) => [bone.bone, bone])
  const bones = Object.fromEntries(entries.map(([name, data]) => [name, { node: nodes[data.node] }])) as VRMHumanBones
  const humanoid = new VRMHumanoid(bones)
  scene.add(humanoid.normalizedHumanBonesRoot)
  const vrm = new VRM({ scene, humanoid, meta: { metaVersion: version } as VRM['meta'] })
  VRMUtils.rotateVRM0(vrm)
  const motion = new AvatarMotionController(vrm, new THREE.AnimationMixer(scene), async () => { throw new Error('No imported animation') })
  await motion.initialize()
  const step = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) { motion.update(1 / 60); vrm.update(1 / 60) }
    scene.updateMatrixWorld(true)
  }
  const checkHands = () => {
    for (const side of ['left', 'right'] as const) {
      const upper = bones[`${side}UpperArm`].node.getWorldPosition(new THREE.Vector3())
      const elbow = bones[`${side}LowerArm`].node.getWorldPosition(new THREE.Vector3())
      const hand = bones[`${side}Hand`].node.getWorldPosition(new THREE.Vector3())
      const armLength = upper.distanceTo(elbow) + elbow.distanceTo(hand)
      assert.ok(hand.y < upper.y - armLength * 0.65, `${basename(path)} ${side} hand must fall below shoulder`)
    }
  }
  step(1)
  checkHands()
  await motion.perform('greet')
  step(5)
  checkHands()
  motion.dispose()
  console.log(`${basename(path)}: VRM ${version}, real rig idle + greet return passed`)
}
