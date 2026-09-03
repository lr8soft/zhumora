import type { AutoApproveMode } from '../../shared/types'

export interface PendingPermission {
  sessionId: string
  resolve: (allowed: boolean) => void
}

/** Per-process mutable state owned by the IPC adapter. */
export class AgentIpcRuntime {
  readonly abortControllers = new Map<string, AbortController>()
  readonly runningSessions = new Set<string>()
  readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly approveModes = new Map<string, AutoApproveMode>()

  constructor(private readonly send: (channel: string, payload: unknown) => void) {}

  getApproveMode(sessionId: string): AutoApproveMode {
    return this.approveModes.get(sessionId) || 'manual'
  }

  setApproveMode(sessionId: string, mode: AutoApproveMode): void {
    this.approveModes.set(sessionId, mode)
  }

  deleteSession(sessionId: string): void {
    this.approveModes.delete(sessionId)
  }

  setRunning(sessionId: string, running: boolean): void {
    if (running) this.runningSessions.add(sessionId)
    else this.runningSessions.delete(sessionId)
    this.send('agent:running', { sessionId, running })
  }

  abort(sessionId: string): void {
    this.abortControllers.get(sessionId)?.abort()
    this.abortControllers.delete(sessionId)
    this.setRunning(sessionId, false)
    this.rejectPendingPermissions(sessionId)
  }

  rejectPendingPermissions(sessionId: string): void {
    for (const [permissionId, pending] of this.pendingPermissions) {
      if (pending.sessionId !== sessionId) continue
      pending.resolve(false)
      this.pendingPermissions.delete(permissionId)
    }
  }
}
