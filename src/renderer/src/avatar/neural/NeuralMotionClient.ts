import type { GeneratedMotion } from './inference'

interface Handshake { classes: string[] }
interface Reply { id: number; motion?: GeneratedMotion | null; error?: string }

/** One worker per Avatar window; generation never blocks the render loop. */
export class NeuralMotionClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, { resolve: (motion: GeneratedMotion | null) => void; reject: (error: Error) => void }>()
  private readonly available: Promise<string[]>
  private readonly resolveClasses: (names: string[]) => void
  private readonly rejectClasses: (error: Error) => void
  private nextId = 0
  private disposed = false

  constructor() {
    let resolveClasses!: (names: string[]) => void
    let rejectClasses!: (error: Error) => void
    this.available = new Promise<string[]>((resolve, reject) => {
      resolveClasses = resolve
      rejectClasses = reject
    })
    this.resolveClasses = resolveClasses
    this.rejectClasses = rejectClasses
    this.worker = new Worker(new URL('./motionWorker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (event: MessageEvent<Handshake | Reply>) => {
      if ('classes' in event.data) {
        this.resolveClasses(event.data.classes)
        return
      }
      const { id, motion, error } = event.data
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      if (error) request.reject(new Error(error))
      else request.resolve(motion ?? null)
    })
    this.worker.addEventListener('error', () => this.fail(new Error('Avatar motion worker failed.')))
  }

  /** Trained action names, or a rejection when the worker never started. */
  classes(): Promise<string[]> {
    return this.available
  }

  generate(text: string): Promise<GeneratedMotion | null> {
    if (this.disposed) return Promise.reject(new Error('Avatar motion worker was disposed.'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, text })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worker.terminate()
    this.fail(new Error('Avatar motion worker was disposed.'))
  }

  private fail(error: Error): void {
    // Settling an already-resolved handshake is a no-op, so a late worker
    // failure after a successful startup only cancels in-flight generations.
    this.rejectClasses(error)
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
}
