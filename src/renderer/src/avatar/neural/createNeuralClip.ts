import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { VRMHumanBoneName } from '@pixiv/three-vrm'
import type { GeneratedMotion } from './inference'
import { createBuiltinMotion } from '../motionClips.ts'

/** Convert canonical VRM1 rotations to this model's normalized VRM rig. */
export function createNeuralClip(vrm: VRM, motion: GeneratedMotion, intensity: number): THREE.AnimationClip {
  const duration = motion.duration
  if (!Number.isFinite(duration) || duration <= 0 || motion.frames < 2 || motion.rotations.length !== motion.frames * motion.bones.length * 4) {
    throw new Error('Avatar motion model returned an invalid sequence.')
  }
  const times = Array.from({ length: motion.frames }, (_, frame) => duration * frame / (motion.frames - 1))
  const idle = createBuiltinMotion(vrm, 'idle')
  const rest = new Map(idle.tracks.map(track => [track.name, new THREE.Quaternion().fromArray(track.values)]))
  const tracks: THREE.KeyframeTrack[] = []
  const amount = THREE.MathUtils.clamp(intensity, 0, 1)
  for (let boneIndex = 0; boneIndex < motion.bones.length; boneIndex++) {
    const node = vrm.humanoid.getNormalizedBoneNode(motion.bones[boneIndex] as VRMHumanBoneName)
    if (!node) continue
    const name = `${node.uuid}.quaternion`
    const neutral = rest.get(name) ?? new THREE.Quaternion()
    const values: number[] = []
    const previous = new THREE.Quaternion()
    for (let frame = 0; frame < motion.frames; frame++) {
      const offset = (frame * motion.bones.length + boneIndex) * 4
      const target = new THREE.Quaternion().fromArray(motion.rotations, offset)
      if (vrm.meta.metaVersion === '0') { target.x *= -1; target.z *= -1 }
      const pose = neutral.clone().slerp(target, amount).normalize()
      if (frame > 0 && previous.dot(pose) < 0) pose.set(-pose.x, -pose.y, -pose.z, -pose.w)
      values.push(pose.x, pose.y, pose.z, pose.w)
      previous.copy(pose)
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(name, times, values))
  }
  if (!tracks.length) throw new Error('Avatar motion model has no supported bones.')
  return new THREE.AnimationClip(`neural:${motion.name}`, duration, tracks)
}
