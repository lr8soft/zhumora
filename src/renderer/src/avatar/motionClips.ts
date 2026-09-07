import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import type { AvatarIntent } from '../../../shared/avatar.ts'

type Angles = [number, number, number]
type Pose = Partial<Record<VRMHumanBoneName, Angles>>
const durations: Record<AvatarIntent, number> = {
  idle: 6, thinking: 5, explain: 4, acknowledge: 2, disagree: 2.4, greet: 3, celebrate: 3
}

/** Original application-owned curves in canonical VRM1 space. */
function poseAt(intent: AvatarIntent, t: number, variant: number, intensity: number): Pose {
  const phase = t * Math.PI * 2
  const envelope = Math.sin(Math.PI * t) ** 2 * intensity
  const pose: Pose = {
    hips: [0, 0, 0], spine: [Math.sin(phase) * 0.012, 0, Math.sin(phase) * 0.012],
    chest: [0, Math.sin(phase) * 0.014, 0], upperChest: [0, 0, 0],
    neck: [0, 0, 0], head: [0, 0, 0],
    leftShoulder: [0, 0, 0], rightShoulder: [0, 0, 0],
    leftUpperArm: [0.04, 0, -1.32], rightUpperArm: [0.04, 0, 1.32],
    leftLowerArm: [0, -0.15, 0], rightLowerArm: [0, 0.15, 0],
    leftHand: [0, 0, -0.06], rightHand: [0, 0, 0.06],
    leftUpperLeg: [0, 0, 0], rightUpperLeg: [0, 0, 0],
    leftLowerLeg: [0, 0, 0], rightLowerLeg: [0, 0, 0],
    leftFoot: [0, 0, 0], rightFoot: [0, 0, 0]
  }
  if (intent === 'idle') {
    pose.head = [0, Math.sin(phase) * 0.045 * variant, envelope * 0.04 * variant]
    pose.spine![2] += envelope * 0.025 * variant
  } else if (intent === 'thinking') {
    pose.head = [0.10 * envelope, 0.10 * envelope, -0.09 * envelope]
    pose.chest![1] = -0.07 * envelope
    pose.rightUpperArm = [-0.25 * envelope, 0, 1.32 - 0.3 * envelope]
    pose.rightLowerArm = [-0.3 * envelope, 0.15 + 0.8 * envelope, 0]
  } else if (intent === 'acknowledge') {
    pose.head = [Math.sin(phase * 2) * 0.2 * envelope, 0, 0]
  } else if (intent === 'disagree') {
    pose.head = [0, Math.sin(phase * 2) * 0.25 * envelope, 0]
  } else if (intent === 'greet') {
    pose.rightUpperArm = [0, 0, 1.32 - 2.05 * envelope]
    pose.rightLowerArm = [0, 0.15, 0.2 * envelope]
    pose.rightHand = [0, 0, Math.sin(phase * 4) * 0.3 * envelope]
    pose.head = [0, 0, 0.07 * envelope]
  } else if (intent === 'explain') {
    const side = variant < 0 ? 'left' : 'right'
    const sign = side === 'left' ? -1 : 1
    pose[`${side}UpperArm`] = [-0.25 * envelope, 0, sign * (1.32 - 0.65 * envelope)]
    pose[`${side}LowerArm`] = [-0.2 * envelope, sign * (0.15 + 0.5 * envelope), 0]
    pose.head = [Math.sin(phase * 2) * 0.05 * envelope, 0.07 * envelope * variant, 0]
  } else if (intent === 'celebrate') {
    pose.leftUpperArm![2] += 1.3 * envelope
    pose.rightUpperArm![2] -= 1.3 * envelope
    pose.head = [-0.1 * envelope, 0, 0]
  }
  return pose
}

export function createBuiltinMotion(vrm: VRM, intent: AvatarIntent, variant = 1, intensity = 0.7): THREE.AnimationClip {
  const duration = durations[intent]
  const times = Array.from({ length: 61 }, (_, i) => duration * i / 60)
  const samples = times.map(time => poseAt(intent, time / duration, variant, intensity))
  const tracks: THREE.KeyframeTrack[] = []
  for (const bone of Object.keys(samples[0]) as VRMHumanBoneName[]) {
    const node = vrm.humanoid.getNormalizedBoneNode(bone)
    if (!node) continue
    const values: number[] = []
    for (const pose of samples) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...pose[bone]!))
      // Same conversion as createVRMAnimationClip; rotating the root isn't enough.
      if (vrm.meta.metaVersion === '0') { rotation.x *= -1; rotation.z *= -1 }
      values.push(...rotation.toArray())
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, values))
  }
  return new THREE.AnimationClip(`builtin:${intent}:${variant}:${intensity}`, duration, tracks)
}
