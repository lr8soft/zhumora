import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import type { AvatarActivity } from '../../../shared/avatar.ts'
import { canonicalRotation } from './motionClips.ts'

type Angles = [number, number, number]

interface BoneEntry {
  node: THREE.Object3D
  bone: VRMHumanBoneName
  phase: number
  applied: THREE.Quaternion
  appliedInverse: THREE.Quaternion
  dirty: boolean
}

const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const
const FINGER_JOINTS = ['Proximal', 'Intermediate'] as const
const scratchEuler = new THREE.Euler()

/**
 * Additive ambient motion composed on top of mixer output: breathing, weight
 * shifts, arm sway and finger flexion. `undo()` restores the pre-overlay pose
 * and `apply()` writes a fresh overlay; the scene sandwiches mixer updates
 * between them so overlays never accumulate on untracked bones.
 */
export class AvatarLifeMotion {
  private readonly entries: BoneEntry[] = []
  private readonly hipsNode: THREE.Object3D | null
  private readonly hipsOffset = new THREE.Vector3()
  private hipsDirty = false
  private readonly vrm0: boolean
  private readonly metaVersion: '0' | '1'
  private readonly random: () => number
  private elapsed = 0
  private activity: AvatarActivity = 'idle'

  constructor(vrm: VRM, random: () => number = Math.random) {
    this.vrm0 = vrm.meta.metaVersion === '0'
    this.metaVersion = vrm.meta.metaVersion
    this.random = random
    const bones: VRMHumanBoneName[] = [
      'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
      'leftShoulder', 'rightShoulder',
      'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand'
    ]
    for (const side of ['left', 'right'] as const) {
      for (const finger of FINGERS) {
        for (const joint of FINGER_JOINTS) bones.push(`${side}${finger}${joint}` as VRMHumanBoneName)
      }
    }
    for (const bone of bones) {
      // Optional bones (fingers, upperChest, shoulders) drop out safely when absent.
      const node = vrm.humanoid.getNormalizedBoneNode(bone)
      if (!node) continue
      this.entries.push({
        node, bone, phase: this.random() * Math.PI * 2,
        applied: new THREE.Quaternion(), appliedInverse: new THREE.Quaternion(), dirty: false
      })
    }
    this.hipsNode = vrm.humanoid.getNormalizedBoneNode('hips')
  }

  setActivity(activity: AvatarActivity): void {
    this.activity = activity
  }

  /** Remove last frame's overlay. Run immediately before mixer updates. */
  undo(): void {
    for (const entry of this.entries) {
      if (!entry.dirty) continue
      entry.node.quaternion.multiply(entry.appliedInverse)
      entry.dirty = false
    }
    if (this.hipsNode && this.hipsDirty) {
      this.hipsNode.position.sub(this.hipsOffset)
      this.hipsDirty = false
    }
  }

  /** Compose a fresh overlay onto the mixer pose. Run after mixer updates. */
  apply(delta: number): void {
    this.elapsed += delta
    const t = this.elapsed
    const energy = this.activity === 'speaking' ? 1.35 : this.activity === 'thinking' ? 0.75 : 1
    const breath = Math.sin(t * (Math.PI * 2 / 4.2))
    const breathLate = Math.sin(t * (Math.PI * 2 / 4.2) - 0.7)
    for (const entry of this.entries) {
      const angles = this.offsets(entry, t, breath, breathLate, energy)
      if (!angles) continue
      entry.applied.copy(canonicalRotation(angles, this.metaVersion))
      entry.node.quaternion.multiply(entry.applied)
      entry.appliedInverse.copy(entry.applied).invert()
      entry.dirty = true
    }
    if (this.hipsNode) {
      this.hipsOffset.set(
        (Math.sin(t * 0.23 + 1.1) + 0.6 * Math.sin(t * 0.41)) * 0.005 * energy,
        breath * 0.0025 * energy,
        Math.sin(t * 0.29 + 2.3) * 0.003 * energy
      )
      if (this.vrm0) { this.hipsOffset.x *= -1; this.hipsOffset.z *= -1 }
      this.hipsNode.position.add(this.hipsOffset)
      this.hipsDirty = true
    }
  }

  dispose(): void {
    this.entries.length = 0
  }

  private offsets(entry: BoneEntry, t: number, breath: number, breathLate: number, energy: number): Angles | null {
    const wobble = (rate: number, phase = entry.phase) => Math.sin(t * rate + phase)
    switch (entry.bone) {
      case 'hips': return [0, wobble(0.19) * 0.01, wobble(0.17) * 0.01]
      case 'spine': return [breath * 0.01 * energy, wobble(0.23) * 0.012, wobble(0.27) * 0.012]
      case 'chest': return [breathLate * 0.008 * energy, wobble(0.21) * 0.01, wobble(0.25) * 0.008]
      case 'upperChest': return [breathLate * 0.005 * energy, 0, 0]
      case 'neck': return [breath * -0.004 * energy, wobble(0.13) * 0.015, wobble(0.11) * 0.01]
      case 'head': return [breath * -0.004 * energy, wobble(0.13, entry.phase + 0.4) * 0.02, wobble(0.1, entry.phase + 0.8) * 0.014]
    }
    const side = entry.bone.startsWith('left') ? -1 : 1
    if (entry.bone.endsWith('Shoulder')) return [0, 0, -side * breath * 0.008 * energy]
    if (entry.bone.endsWith('UpperArm')) {
      return [breath * 0.012 * energy + wobble(0.31) * 0.012, side * wobble(0.29) * 0.015, side * wobble(0.24) * 0.018]
    }
    if (entry.bone.endsWith('LowerArm')) return [0, side * wobble(0.33) * 0.02, 0]
    if (entry.bone.endsWith('Hand')) return [0, 0, side * wobble(0.37) * 0.02]
    if (FINGER_JOINTS.some(joint => entry.bone.endsWith(joint))) {
      const curl = entry.bone.endsWith('Proximal') ? 0.14 : 0.2
      return [0, 0, side * (curl + wobble(0.45) * 0.04)]
    }
    return null
  }
}
