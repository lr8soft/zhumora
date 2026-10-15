import { normalizeProviderConcurrency, type ProviderRequestLoad } from '../../shared/providerConcurrency.ts'

interface WaitingRequest {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort: () => void
}
interface ProviderQueue { limit: number | null; active: number; waiting: WaitingRequest[] }

function aborted(): Error { return new DOMException('LLM request cancelled before execution', 'AbortError') }

/** Network-capacity adapter, keyed by provider ID; never owns sessions or Agent controllers. */
export class ProviderRequestConcurrency {
  private readonly queues = new Map<string, ProviderQueue>()
  private disposed = false

  acquire(id: string, limit: number | null | undefined, signal?: AbortSignal): Promise<() => void> {
    if (this.disposed || signal?.aborted) return Promise.reject(aborted())
    const normalized = normalizeProviderConcurrency(limit)
    let queue = this.queues.get(id)
    if (!queue) {
      queue = { limit: normalized, active: 0, waiting: [] }
      this.queues.set(id, queue)
    }
    queue.limit = normalized
    const state = queue
    return new Promise((resolve, reject) => {
      const request: WaitingRequest = { resolve, reject, signal, onAbort: () => {
        const index = state.waiting.indexOf(request)
        if (index < 0) return
        state.waiting.splice(index, 1)
        signal?.removeEventListener('abort', request.onAbort)
        reject(aborted())
        this.drain(id, state)
      } }
      state.waiting.push(request)
      signal?.addEventListener('abort', request.onAbort, { once: true })
      this.drain(id, state)
    })
  }

  configureLimits(providers: readonly { id: string; maxConcurrency?: number | null }[]): void {
    const limits = new Map(providers.map(provider => [provider.id, normalizeProviderConcurrency(provider.maxConcurrency)]))
    for (const [id, queue] of this.queues) {
      if (limits.has(id)) queue.limit = limits.get(id)!
      this.drain(id, queue)
    }
  }

  snapshot(): Record<string, ProviderRequestLoad> {
    return Object.fromEntries([...this.queues].map(([id, queue]) => [id, { active: queue.active, waiting: queue.waiting.length }]))
  }

  dispose(): void {
    this.disposed = true
    for (const queue of this.queues.values()) for (const request of queue.waiting.splice(0)) {
      request.signal?.removeEventListener('abort', request.onAbort)
      request.reject(aborted())
    }
    this.queues.clear()
  }

  private drain(id: string, queue: ProviderQueue): void {
    while (!this.disposed && queue.waiting.length && (queue.limit === null || queue.active < queue.limit)) {
      const request = queue.waiting.shift()!
      request.signal?.removeEventListener('abort', request.onAbort)
      if (request.signal?.aborted) { request.reject(aborted()); continue }
      queue.active++
      let released = false
      request.resolve(() => {
        if (released) return
        released = true
        queue.active--
        this.drain(id, queue)
      })
    }
    if (!queue.active && !queue.waiting.length && this.queues.get(id) === queue) this.queues.delete(id)
  }
}
