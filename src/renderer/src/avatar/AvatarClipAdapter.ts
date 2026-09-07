import * as THREE from 'three'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import { createBuiltinMotion } from './motionClips.ts'

interface BoneBinding {
  name: VRMHumanBoneName
  node: THREE.Object3D
  parentRotation: THREE.Quaternion
  restRotation: THREE.Quaternion
}

/** Captures the authoring rest frame before rotateVRM0 or any motion is applied. */
export class AvatarClipAdapter {
  private readonly raw = new Map<string, BoneBinding>()
  private readonly normalized = new Map<string, BoneBinding>()
  private readonly rest: THREE.AnimationClip

  constructor(vrm: VRM) {
    vrm.scene.updateMatrixWorld(true)
    this.rest = createBuiltinMotion(vrm, 'idle')
    for (const [name, bone] of Object.entries(vrm.humanoid.rawHumanBones)) {
      if (!bone) continue
      const node = vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName)
      if (!node) continue
      const binding: BoneBinding = {
        name: name as VRMHumanBoneName, node,
        parentRotation: bone.node.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion(),
        restRotation: bone.node.quaternion.clone()
      }
      this.raw.set(bone.node.uuid, binding)
      if (bone.node.name) this.raw.set(bone.node.name, binding)
      this.normalized.set(node.uuid, binding)
      if (node.name) this.normalized.set(node.name, binding)
    }
  }

  adapt(source: THREE.AnimationClip): THREE.AnimationClip {
    if (!(source.duration > 0) || !Number.isFinite(source.duration) || !source.tracks.length) {
      throw new Error('Animation contains no playable tracks.')
    }
    const clip = source.clone()
    const animated = new Set<string>()
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.')
      const name = track.name.slice(0, dot)
      const property = track.name.slice(dot + 1)
      const raw = this.raw.get(name)
      const binding = raw ?? this.normalized.get(name)
      if (!binding) continue
      track.name = `${binding.node.uuid}.${property}`
      animated.add(track.name)
      if (raw && track instanceof THREE.QuaternionKeyframeTrack) {
        const parentInverse = raw.parentRotation.clone().invert()
        const restInverse = raw.restRotation.clone().invert()
        for (let i = 0; i < track.values.length; i += 4) {
          const q = new THREE.Quaternion().fromArray(track.values, i)
          q.multiply(restInverse).premultiply(raw.parentRotation).multiply(parentInverse)
          q.toArray(track.values, i)
        }
      }
      if (binding.name === 'hips' && track instanceof THREE.VectorKeyframeTrack) {
        const firstY = track.values[1]
        // A desktop companion stays anchored; preserve vertical motion only.
        for (let i = 0; i < track.values.length; i += 3) {
          track.values[i] = binding.node.position.x
          track.values[i + 1] += binding.node.position.y - firstY
          track.values[i + 2] = binding.node.position.z
        }
      }
    }
    // Sparse gestures must retain a relaxed body instead of blending unused
    // joints back to the model's T-pose as the outgoing action loses weight.
    for (const track of this.rest.tracks) {
      if (animated.has(track.name)) continue
      const q = Array.from(track.values.slice(0, 4))
      clip.tracks.push(new THREE.QuaternionKeyframeTrack(track.name, [0, clip.duration], [...q, ...q]))
    }
    return clip
  }
}
