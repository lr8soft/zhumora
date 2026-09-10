import { AgentAbortedError } from '../../shared/types.ts'

export type BotMessageTask = (signal: AbortSignal) => Promise<void>

/** Transport-side FIFO only. Session execution and ownership stay in SessionService. */
export class BotMessageQueue {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly active = new Map<string, AbortController>()
  private generation = 0

  enqueue(conversationId: string, task: BotMessageTask): Promise<void> {
    const previous = this.queues.get(conversationId) || Promise.resolve()
    const generation = this.generation
    const queued = previous.catch(() => {}).then(async () => {
      if (generation !== this.generation) return
      const controller = new AbortController()
      this.active.set(conversationId, controller)
      try {
        await task(controller.signal)
      } catch (error) {
        if (controller.signal.aborted && !(error instanceof AgentAbortedError)) throw new AgentAbortedError()
        throw error
      } finally {
        if (this.active.get(conversationId) === controller) this.active.delete(conversationId)
      }
    })
    this.queues.set(conversationId, queued)
    void queued.finally(() => {
      if (this.queues.get(conversationId) === queued) this.queues.delete(conversationId)
    }).catch(() => {})
    return queued
  }

  abortConversation(conversationId: string): boolean {
    const controller = this.active.get(conversationId)
    if (!controller) return false
    controller.abort()
    return true
  }

  async stop(): Promise<void> {
    this.generation++
    for (const controller of this.active.values()) controller.abort()
    const pending = [...new Set(this.queues.values())]
    this.queues.clear()
    await Promise.allSettled(pending)
    this.active.clear()
  }
}
