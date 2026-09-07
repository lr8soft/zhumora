import type { VRMExpressionManager } from '@pixiv/three-vrm'
import type { AvatarEmotion } from '../../../shared/avatar.ts'

interface Fade { from: number; to: number }

export class AvatarExpressionController {
  private readonly manager: VRMExpressionManager
  private readonly random: () => number
  private readonly fades = new Map<string, Fade>()
  private elapsed = 0
  private releaseAt = Infinity
  private fadeTime = 0
  private nextBlink = 2
  private blinkTime = -1
  private blinkBase = 0
  private readonly blink: string | undefined

  constructor(manager: VRMExpressionManager, random: () => number = Math.random) {
    this.manager = manager
    this.random = random
    this.blink = this.resolve('blink')
  }

  resolve(name: string): string | undefined {
    const names = Object.keys(this.manager.expressionMap)
    if (names.includes(name)) return name
    const matches = names.filter(candidate => candidate.toLowerCase() === name.toLowerCase())
    return matches.length === 1 ? matches[0] : undefined
  }

  emotion(emotion: AvatarEmotion, intensity: number): void {
    const name = this.resolve(emotion)
    // Unsupported emotions degrade to neutral, not an invented morph.
    this.transition(name && emotion !== 'neutral' ? name : undefined, intensity * 0.75)
  }

  expression(name: string, value: number): void {
    const actual = this.resolve(name)
    if (!actual) throw new Error(`Unknown Avatar expression "${name}".`)
    this.transition(actual, value)
  }

  reset(): void { this.transition(undefined, 0) }

  update(delta: number): void {
    // Remove last frame's blink overlay before sampling the expression channel.
    if (this.blink && this.blinkTime >= 0) this.manager.setValue(this.blink, this.blinkBase)
    this.elapsed += delta
    if (this.elapsed >= this.releaseAt) this.reset()
    this.fadeTime = Math.min(1, this.fadeTime + delta / 0.35)
    const t = this.fadeTime * this.fadeTime * (3 - 2 * this.fadeTime)
    for (const [name, fade] of this.fades) this.manager.setValue(name, fade.from + (fade.to - fade.from) * t)
    if (!this.blink) return
    this.blinkBase = this.manager.getValue(this.blink) ?? 0
    if (this.elapsed >= this.nextBlink && this.blinkTime < 0) this.blinkTime = 0
    if (this.blinkTime < 0) return
    this.blinkTime += delta
    if (this.blinkTime >= 0.2) {
      this.blinkTime = -1
      this.nextBlink = this.elapsed + 2 + this.random() * 4
      this.manager.setValue(this.blink, this.blinkBase)
    } else {
      this.manager.setValue(this.blink, Math.max(this.blinkBase, Math.sin(Math.PI * this.blinkTime / 0.2)))
    }
  }

  private transition(name: string | undefined, value: number): void {
    this.fades.clear()
    for (const candidate of Object.keys(this.manager.expressionMap)) {
      // Gaze owns these channels. The VRM expression manager resolves blink overrides.
      if (/^look(up|down|left|right)$/i.test(candidate)) continue
      const from = candidate === this.blink && this.blinkTime >= 0
        ? this.blinkBase : this.manager.getValue(candidate) ?? 0
      this.fades.set(candidate, { from, to: candidate === name ? value : 0 })
    }
    this.fadeTime = 0
    this.releaseAt = name ? this.elapsed + 4 : Infinity
  }
}
