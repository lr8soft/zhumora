import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import type { AvatarIntent } from '../../../shared/avatar.ts'

type Angles = [number, number, number]
type Pose = Partial<Record<VRMHumanBoneName, Angles>>
const durations: Record<AvatarIntent, number> = {
  idle: 6, acknowledge: 2, disagree: 2.4, greet: 3, celebrate: 3, sad: 5,
  wave: 3.5, shrug: 2.8, bow: 3.5, applaud: 3
}

/** Canonical VRM1-space euler → normalized-node local rotation, with the VRM0 x/z flip. */
export function canonicalRotation(angles: Angles, metaVersion: '0' | '1'): THREE.Quaternion {
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles))
  // Same conversion as createVRMAnimationClip; rotating the root isn't enough.
  if (metaVersion === '0') { rotation.x *= -1; rotation.z *= -1 }
  return rotation
}

/** Natural hanging arms in canonical VRM1 space; everything else rests neutral. */
const rest: Pose = {
  hips: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], upperChest: [0, 0, 0],
  neck: [0, 0, 0], head: [0, 0, 0],
  leftShoulder: [0, 0, 0], rightShoulder: [0, 0, 0],
  leftUpperArm: [0.05, 0, -1.44], rightUpperArm: [0.05, 0, 1.44],
  leftLowerArm: [0, -0.22, 0], rightLowerArm: [0, 0.22, 0],
  leftHand: [0, 0, -0.06], rightHand: [0, 0, 0.06],
  leftUpperLeg: [0, 0, 0], rightUpperLeg: [0, 0, 0],
  leftLowerLeg: [0, 0, 0], rightLowerLeg: [0, 0, 0],
  leftFoot: [0, 0, 0], rightFoot: [0, 0, 0]
}

/** Original application-owned curves in canonical VRM1 space. */
function poseAt(intent: AvatarIntent, t: number, variant: number, intensity: number): Pose {
  const phase = t * Math.PI * 2
  // Flatter envelopes keep multi-beat gestures (nod, wave, clap) evenly visible;
  // bow/shrug ease in and out; head cues use a stronger bell.
  const shape = intent === 'wave' || intent === 'applaud' ? 0.85
    : intent === 'acknowledge' || intent === 'disagree' ? 0.5
      : intent === 'shrug' || intent === 'bow' ? 1 : 2
  const envelope = Math.sin(Math.PI * t) ** shape * intensity
  const pose: Pose = {
    ...rest,
    spine: [Math.sin(phase) * 0.012, 0, Math.sin(phase) * 0.012],
    chest: [0, Math.sin(phase) * 0.014, 0]
  }
  if (intent === 'idle') {
    pose.head = [0, Math.sin(phase) * 0.045 * variant, envelope * 0.04 * variant]
    pose.spine![2] += envelope * 0.025 * variant
  } else if (intent === 'acknowledge') {
    pose.head = [Math.sin(phase * 3) * 0.38 * envelope, 0, 0]
    pose.neck = [Math.sin(phase * 3) * 0.1 * envelope, 0, 0]
  } else if (intent === 'disagree') {
    pose.head = [0, Math.sin(phase * 2.5) * 0.46 * envelope, 0]
    pose.neck = [0, Math.sin(phase * 2.5) * 0.12 * envelope, 0]
  } else if (intent === 'greet') {
    pose.head = [0.1 * envelope, 0, 0.035 * envelope]
  } else if (intent === 'celebrate') {
    pose.head = [-0.06 * envelope, 0, 0.035 * envelope]
  } else if (intent === 'sad') {
    pose.head = [0.18 * envelope, 0, -0.045 * envelope]
    pose.neck = [0.025 * envelope, 0, 0]
    pose.spine![0] += 0.025 * envelope
  } else if (intent === 'wave') {
    // Raise the whole right arm well above the shoulder and swing the hand.
    const wiggle = Math.sin(phase * 3) * envelope
    pose.rightUpperArm = [0.18 * envelope, 0, 1.44 - 2.0 * envelope]
    pose.rightLowerArm = [0, 0.22 + 1.1 * envelope, 0]
    pose.rightHand = [0, 0, 0.06 + 0.6 * wiggle]
    pose.head = [0.02 * envelope, -0.08 * envelope, 0.06 * envelope]
  } else if (intent === 'shrug') {
    pose.leftShoulder = [0, 0, 0.3 * envelope]
    pose.rightShoulder = [0, 0, -0.3 * envelope]
    pose.neck = [0.02 * envelope, 0, 0.02 * envelope]
    pose.head = [0.03 * envelope, 0, 0.07 * envelope]
  } else if (intent === 'bow') {
    // Deep bow: fold the whole torso to roughly 90 degrees at the default strength.
    pose.hips = [-0.05 * envelope, 0, 0]
    pose.spine![0] += 0.58 * envelope
    pose.chest![0] += 0.58 * envelope
    pose.upperChest = [0.42 * envelope, 0, 0]
    pose.neck = [0.12 * envelope, 0, 0]
    pose.head = [0.08 * envelope, 0, 0]
  } else if (intent === 'applaud') {
    // Arm bones extend along ±X: y swings forward/elbow flexion, z raises sideways.
    const clap = Math.sin(phase * 2.5) * envelope
    pose.leftUpperArm = [0, -1.3 * envelope, -1.44 + 0.6 * envelope]
    pose.rightUpperArm = [0, 1.3 * envelope, 1.44 - 0.6 * envelope]
    pose.leftLowerArm = [0, -0.22 - 1.05 * envelope - 0.18 * clap, 0]
    pose.rightLowerArm = [0, 0.22 + 1.05 * envelope + 0.18 * clap, 0]
    pose.leftHand = [0, 0, -0.06 - 0.1 * envelope]
    pose.rightHand = [0, 0, 0.06 + 0.1 * envelope]
    pose.head = [0.03 * Math.abs(clap), 0, 0]
  }
  return pose
}

export function createBuiltinMotion(vrm: VRM, intent: AvatarIntent, variant = 1, intensity = 0.7): THREE.AnimationClip {
  const duration = durations[intent]
  // Gesture curves contain multi-beat oscillation; sample at ~30fps instead of a fixed count.
  const count = Math.max(61, Math.ceil(duration * 30) + 1)
  const times = Array.from({ length: count }, (_, i) => duration * i / (count - 1))
  const samples = times.map(time => poseAt(intent, time / duration, variant, intensity))
  const tracks: THREE.KeyframeTrack[] = []
  for (const bone of Object.keys(samples[0]) as VRMHumanBoneName[]) {
    const node = vrm.humanoid.getNormalizedBoneNode(bone)
    if (!node) continue
    const values: number[] = []
    for (const pose of samples) values.push(...canonicalRotation(pose[bone]!, vrm.meta.metaVersion).toArray())
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, values))
  }
  return new THREE.AnimationClip(`builtin:${intent}:${variant}:${intensity}`, duration, tracks)
}
