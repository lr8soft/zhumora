export interface DesktopControlIndicator {
  show(sessionId: string): Promise<void>
  hide(): void
  dispose(): void
}

/** The desktop is a single physical resource. Ownership lasts until run end;
 * cancellation keeps the lease until the in-flight native request has settled. */
export class DesktopControlCoordinator {
  private owner?: string
  private active = false
  private ending = false
  private disposed = false
  private removeAbort?: () => void
  private readonly indicator: DesktopControlIndicator

  constructor(indicator: DesktopControlIndicator) { this.indicator = indicator }

  async run<T>(sessionId: string | undefined, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (!sessionId) throw new Error('[SESSION_REQUIRED] Desktop input requires a session.')
    if (this.disposed || signal?.aborted) throw new Error('[DESKTOP_ABORTED] Desktop input cancelled.')
    if (this.active || (this.owner && this.owner !== sessionId)) {
      throw new Error('[DESKTOP_BUSY] Another desktop operation owns the desktop. Wait until its run finishes.')
    }
    if (!this.owner) {
      this.owner = sessionId
      const onAbort = () => this.release(sessionId)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.removeAbort = () => signal?.removeEventListener('abort', onAbort)
    }
    this.active = true
    try {
      await this.indicator.show(sessionId)
      if (this.ending || signal?.aborted || this.disposed) throw new Error('[DESKTOP_ABORTED] Desktop input cancelled.')
      return await operation()
    } catch (error) {
      this.ending = true
      throw error
    } finally {
      this.active = false
      if (this.ending) this.clear()
    }
  }

  release(sessionId: string): void {
    if (this.owner !== sessionId) return
    this.ending = true
    this.indicator.hide()
    if (!this.active) this.clear()
  }

  dispose(): void {
    this.disposed = true
    this.clear()
    this.indicator.dispose()
  }

  private clear(): void {
    this.removeAbort?.()
    this.removeAbort = undefined
    this.owner = undefined
    this.ending = false
    this.indicator.hide()
  }
}
