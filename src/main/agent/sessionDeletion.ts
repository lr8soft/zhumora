/** Owned by SessionService: one removal promise per session, never a second run table. */
export class SessionDeletionGate {
  private readonly pending = new Map<string, Promise<void>>()

  has(sessionId: string): boolean { return this.pending.has(sessionId) }

  run(sessionId: string, remove: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(sessionId)
    if (existing) return existing
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const result = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    this.pending.set(sessionId, result)
    // Install the gate before invoking removal, but abort the active run synchronously.
    void (async () => {
      try { await remove(); resolve() }
      catch (error) { reject(error) }
      finally { this.pending.delete(sessionId) }
    })()
    return result
  }
}
