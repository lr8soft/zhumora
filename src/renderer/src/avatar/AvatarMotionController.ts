import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { AvatarActivity, AvatarIntent } from '../../../shared/avatar.ts'
import { createBuiltinMotion } from './motionClips.ts'

type ClipResolver = (name: string) => Promise<THREE.AnimationClip>
export interface AvatarIdleState { name: string; builtIn: boolean }
interface BlendEntry { action: THREE.AnimationAction; start: number }

/** Per-window owner of blending, autonomous scheduling and cancellation. */
export class AvatarMotionController {
  private idle: AvatarIdleState = { name: 'idle', builtIn: true }
  private idleClip: THREE.AnimationClip | undefined
  private readonly builtins = new Map<string, THREE.AnimationClip>()
  private readonly overrideClips = new Map<AvatarIntent, THREE.AnimationClip>()
  private readonly active = new Map<THREE.AnimationAction, BlendEntry>()
  private current: THREE.AnimationAction | undefined
  private activity: AvatarActivity = 'idle'
  private appliedActivity: AvatarActivity = 'idle'
  private nextBaseChange = 0
  private blendTime = 0
  private blendDuration = 0.5
  private elapsed = 0
  private nextVariation = 8
  private overrideUntil = 0
  private generation = 0
  private variant = 1
  private disposed = false
  private readonly vrm: VRM
  private readonly mixer: THREE.AnimationMixer
  private readonly resolveClip: ClipResolver
  private readonly overrides: Partial<Record<AvatarIntent, string>>
  private readonly random: () => number

  constructor(
    vrm: VRM,
    mixer: THREE.AnimationMixer,
    resolveClip: ClipResolver,
    overrides: Partial<Record<AvatarIntent, string>> = {},
    random: () => number = Math.random
  ) {
    this.vrm = vrm
    this.mixer = mixer
    this.resolveClip = resolveClip
    this.overrides = overrides
    this.random = random
  }

  async initialize(preferredIdle?: string): Promise<AvatarIdleState> {
    // Apply rest motion before asynchronous loading can expose T-pose.
    this.start(this.builtin('idle'), true, 0)
    this.mixer.update(0)
    const generation = ++this.generation
    if (preferredIdle) {
      try {
        const clip = await this.resolveClip(preferredIdle)
        if (this.disposed || generation !== this.generation) return this.idle
        this.idleClip = clip
        this.idle = { name: preferredIdle, builtIn: false }
        this.start(clip, true)
      } catch (error) {
        console.warn('Avatar default motion unavailable; using built-in idle.', error)
      }
    }
    await Promise.all(Object.entries(this.overrides).map(async ([intent, name]) => {
      try {
        const clip = await this.resolveClip(name)
        if (!this.disposed && generation === this.generation) this.overrideClips.set(intent as AvatarIntent, clip)
      } catch (error) { console.warn('Avatar semantic override could not be loaded.', error) }
    }))
    return this.idle
  }

  async play(name: string, loop: boolean): Promise<void> {
    const generation = ++this.generation
    const clip = this.idle.builtIn && name === 'idle' ? this.builtin('idle') : await this.resolveClip(name)
    if (this.disposed || generation !== this.generation) throw new Error('Avatar motion was superseded.')
    this.overrideUntil = loop ? Infinity : this.elapsed + clip.duration
    this.start(clip, loop)
  }

  async perform(intent: AvatarIntent, intensity = 0.7): Promise<void> {
    const generation = ++this.generation
    let clip = this.overrideClips.get(intent) ?? this.builtin(intent, intensity)
    const override = this.overrides[intent]
    if (override && !this.overrideClips.has(intent)) {
      try { clip = await this.resolveClip(override) }
      catch (error) { console.warn('Avatar override unavailable; using built-in motion.', error) }
    }
    if (this.disposed || generation !== this.generation) return
    // Semantic requests are bounded; exact play_animation retains explicit looping.
    this.overrideUntil = this.elapsed + Math.min(clip.duration, 12)
    this.start(clip, false)
  }

  setActivity(activity: AvatarActivity): void {
    if (this.activity === activity) return
    this.activity = activity
  }

  async reset(): Promise<void> {
    this.generation++
    this.overrideUntil = 0
    this.startBase()
  }

  update(delta: number): void {
    if (this.disposed) return
    this.elapsed += delta
    if (this.overrideUntil > 0 && this.elapsed >= this.overrideUntil) {
      this.overrideUntil = 0
      this.startBase()
    } else if (this.overrideUntil === 0 && this.activity !== this.appliedActivity && this.elapsed >= this.nextBaseChange) {
      this.startBase()
    } else if (this.overrideUntil === 0 && this.elapsed >= this.nextVariation) {
      this.variant *= -1
      this.startBase()
    }
    this.blendTime += delta
    const t = this.blendDuration === 0 ? 1 : Math.min(1, this.blendTime / this.blendDuration)
    const eased = t * t * (3 - 2 * t)
    for (const [action, entry] of this.active) {
      const target = action === this.current ? 1 : 0
      action.setEffectiveWeight(entry.start + (target - entry.start) * eased)
      if (t === 1 && action !== this.current) {
        action.stop()
        this.active.delete(action)
        this.mixer.uncacheAction(action.getClip())
      }
    }
    this.mixer.update(delta)
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.vrm.scene)
    this.active.clear()
    this.builtins.clear()
    this.overrideClips.clear()
  }

  private builtin(intent: AvatarIntent, intensity = 0.7): THREE.AnimationClip {
    // Bounded per-model cache: 7 intents × 2 variants × 4 intensity levels.
    const strength = intensity === 0 ? 0 : intensity < 0.34 ? 0.3 : intensity < 0.67 ? 0.6 : 0.9
    const key = intent + ':' + this.variant + ':' + strength
    let clip = this.builtins.get(key)
    if (!clip) {
      clip = createBuiltinMotion(this.vrm, intent, this.variant, strength)
      this.builtins.set(key, clip)
    }
    return clip
  }

  private startBase(): void {
    this.appliedActivity = this.activity
    this.nextBaseChange = this.elapsed + 0.7
    const intent = this.activity === 'speaking' ? 'explain' : this.activity
    const clip = intent === 'idle' && this.idleClip ? this.idleClip : this.overrideClips.get(intent) ?? this.builtin(intent)
    this.start(clip, true, 0.65)
    this.nextVariation = this.elapsed + 7 + this.random() * 6
  }

  private start(clip: THREE.AnimationClip, loop: boolean, duration = 0.45): void {
    const action = this.mixer.clipAction(clip)
    // Repeated requests must not reset the currently visible animation phase.
    if (action !== this.current) {
      if (!this.active.has(action)) action.reset().setEffectiveWeight(0).play()
      this.current = action
    }
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
    action.clampWhenFinished = true
    action.paused = false
    if (!this.active.has(action)) this.active.set(action, { action, start: 0 })
    // Snapshot in-flight weights to keep interrupted transitions continuous.
    for (const entry of this.active.values()) entry.start = entry.action.getEffectiveWeight()
    this.blendTime = 0
    this.blendDuration = this.active.size === 1 ? 0 : duration
    if (this.active.size === 1) action.setEffectiveWeight(1)
  }
}
