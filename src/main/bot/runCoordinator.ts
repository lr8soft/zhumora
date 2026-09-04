import { AgentAbortedError } from '../../shared/types.ts'
import type { BotActivity } from './contracts'

interface PermissionCancellation {
  cancelSession(sessionId: string): void
}

interface ActiveRun {
  controller: AbortController
  sessionId?: string
}

export interface BotRunContext {
  signal: AbortSignal
  onSessionReady(sessionId: string): boolean
}

export type BotRunTask = (context: BotRunContext) => Promise<void>

/**
 * Owns transport-independent Bot run state: per-conversation FIFO ordering,
 * cross-conversation concurrency, session binding, cancellation and activity.
 */
export class BotRunCoordinator {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly activeConversations = new Map<string, ActiveRun>()
  private readonly activeSessions = new Map<string, ActiveRun>()
  private readonly permissions: PermissionCancellation
  private generation = 0
  private onActivity?: (activity: BotActivity) => boolean | void

  constructor(permissions: PermissionCancellation) {
    this.permissions = permissions
  }

  setActivityListener(listener: (activity: BotActivity) => boolean | void): void {
    this.onActivity = listener
  }

  enqueue(conversationId: string, task: BotRunTask): Promise<void> {
    const previous = this.queues.get(conversationId) || Promise.resolve()
    const generation = this.generation
    const queued = previous.catch(() => {}).then(async () => {
      if (generation !== this.generation) return
      await this.runNow(conversationId, task)
    })
    this.queues.set(conversationId, queued)
    void queued.finally(() => {
      if (this.queues.get(conversationId) === queued) this.queues.delete(conversationId)
    }).catch(() => {})
    return queued
  }

  abortConversation(conversationId: string): boolean {
    const run = this.activeConversations.get(conversationId)
    if (!run) return false
    run.controller.abort()
    if (run.sessionId) this.permissions.cancelSession(run.sessionId)
    return true
  }

  abortSession(sessionId: string): boolean {
    const run = this.activeSessions.get(sessionId)
    if (!run) return false
    run.controller.abort()
    this.permissions.cancelSession(sessionId)
    return true
  }

  async stop(): Promise<void> {
    this.generation++
    for (const run of this.activeConversations.values()) {
      run.controller.abort()
      if (run.sessionId) this.permissions.cancelSession(run.sessionId)
    }
    const pending = [...new Set(this.queues.values())]
    this.queues.clear()
    await Promise.allSettled(pending)
    this.activeConversations.clear()
    this.activeSessions.clear()
  }

  private async runNow(conversationId: string, task: BotRunTask): Promise<void> {
    const run: ActiveRun = { controller: new AbortController() }
    this.activeConversations.set(conversationId, run)
    let terminalState: BotActivity['state'] = 'complete'
    try {
      await task({
        signal: run.controller.signal,
        onSessionReady: sessionId => this.bindSession(run, sessionId)
      })
    } catch (error) {
      terminalState = run.controller.signal.aborted || error instanceof AgentAbortedError
        ? 'aborted'
        : 'error'
      throw error
    } finally {
      if (run.sessionId) {
        this.permissions.cancelSession(run.sessionId)
        this.onActivity?.({ sessionId: run.sessionId, state: terminalState })
        if (this.activeSessions.get(run.sessionId) === run) this.activeSessions.delete(run.sessionId)
      }
      if (this.activeConversations.get(conversationId) === run) this.activeConversations.delete(conversationId)
    }
  }

  private bindSession(run: ActiveRun, sessionId: string): boolean {
    if (run.controller.signal.aborted || this.activeSessions.has(sessionId)) return false
    if (this.onActivity?.({ sessionId, state: 'running' }) === false) return false
    run.sessionId = sessionId
    this.activeSessions.set(sessionId, run)
    return true
  }
}
