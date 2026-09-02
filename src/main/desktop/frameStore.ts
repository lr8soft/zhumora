import type { BoundsEntry } from '@mediar-ai/terminator'
import type { DesktopBounds, DesktopTarget } from './types'

export interface StoredDesktopTarget {
  ref: string
  process: string
  title?: string
  selector?: string
  role: string
  name: string
  bounds: DesktopBounds
}

interface StoredFrame {
  createdAt: number
  targets: Map<string, StoredDesktopTarget>
}

export class DesktopFrameStore {
  private readonly frames = new Map<string, StoredFrame>()
  private sequence = 0
  private readonly maxFrames: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(
    maxFrames = 16,
    ttlMs = 2 * 60 * 1000,
    now: () => number = Date.now
  ) {
    this.maxFrames = maxFrames
    this.ttlMs = ttlMs
    this.now = now
  }

  createFrame(process: string, title: string | undefined, entries: Record<string, BoundsEntry>, maxElements: number): {
    frameId: string
    targets: DesktopTarget[]
  } {
    this.prune()
    const frameId = `f${this.now().toString(36)}_${(++this.sequence).toString(36)}`
    const storedTargets = new Map<string, StoredDesktopTarget>()
    const targets = Object.entries(entries)
      .sort(([a], [b]) => Number(a) - Number(b))
      .slice(0, Math.max(1, maxElements))
      .map(([index, entry]) => {
        const ref = `${frameId}:u${index}`
        const target: StoredDesktopTarget = {
          ref,
          process,
          title,
          selector: entry.selector,
          role: entry.role,
          name: entry.name,
          bounds: { ...entry.bounds }
        }
        storedTargets.set(ref, target)
        return {
          ref,
          role: target.role,
          name: target.name,
          bounds: target.bounds
        }
      })

    this.frames.set(frameId, { createdAt: this.now(), targets: storedTargets })
    while (this.frames.size > this.maxFrames) {
      const oldest = this.frames.keys().next().value as string | undefined
      if (!oldest) break
      this.frames.delete(oldest)
    }
    return { frameId, targets }
  }

  createEmptyFrame(): string {
    this.prune()
    const frameId = `f${this.now().toString(36)}_${(++this.sequence).toString(36)}`
    this.frames.set(frameId, { createdAt: this.now(), targets: new Map() })
    while (this.frames.size > this.maxFrames) {
      const oldest = this.frames.keys().next().value as string | undefined
      if (!oldest) break
      this.frames.delete(oldest)
    }
    return frameId
  }

  resolve(ref: string): StoredDesktopTarget {
    this.prune()
    const frameId = ref.split(':', 1)[0]
    const frame = this.frames.get(frameId)
    const target = frame?.targets.get(ref)
    if (!target) {
      throw new Error(`[STALE_REF] Desktop target "${ref}" is missing or expired. Call desktop_observe again.`)
    }
    return target
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [id, frame] of this.frames) {
      if (frame.createdAt < cutoff) this.frames.delete(id)
    }
  }
}
