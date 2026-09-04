import type { AutoApproveMode } from '../../shared/types'
import { generateId } from '../id.ts'
import type { PermissionLevel, ToolRegistry } from '../tools/registry'
import { decidePermission } from './permissionPolicy.ts'

export type PermissionResolution = 'approved' | 'denied' | 'cancelled' | 'timeout'

export interface PermissionRequest {
  id: string
  sessionId: string
  toolName: string
  args: Record<string, unknown>
  level: PermissionLevel
}

export interface PermissionPresenter {
  present(request: PermissionRequest): void | Promise<void>
  resolve?(request: PermissionRequest, resolution: PermissionResolution): void | Promise<void>
}

interface PendingPermission {
  request: PermissionRequest
  presenters: PermissionPresenter[]
  resolve: (allowed: boolean) => void
  timer?: ReturnType<typeof setTimeout>
}

export interface PermissionCheckOptions {
  sessionId: string
  mode: () => AutoApproveMode
  registry: ToolRegistry
  presenters?: PermissionPresenter[]
  timeoutMs?: number
}

/** Owns pending permission state and arbitrates the first response across presenters. */
export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>()
  private readonly globalPresenters = new Set<PermissionPresenter>()

  addPresenter(presenter: PermissionPresenter): () => void {
    this.globalPresenters.add(presenter)
    return () => this.globalPresenters.delete(presenter)
  }

  createCheck(options: PermissionCheckOptions): (toolName: string, args: Record<string, unknown>) => Promise<boolean> {
    return async (toolName, args) => {
      const level = options.registry.permission(toolName, args)
      const alwaysConfirm = options.registry.alwaysConfirm(toolName)
      if (decidePermission(options.mode(), level, alwaysConfirm) === 'allow') return true
      return this.request({
        sessionId: options.sessionId,
        toolName,
        args,
        level
      }, options.presenters, options.timeoutMs)
    }
  }

  request(
    input: Omit<PermissionRequest, 'id'>,
    extraPresenters: PermissionPresenter[] = [],
    timeoutMs = 0
  ): Promise<boolean> {
    const request: PermissionRequest = { id: generateId(), ...input }
    const presenters = [...new Set([...this.globalPresenters, ...extraPresenters])]
    // Confirmation-required tools must fail closed when no UI or channel can
    // present the request; otherwise the Agent could remain suspended forever.
    if (presenters.length === 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const pending: PendingPermission = { request, presenters, resolve }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => this.settle(request.id, false, 'timeout'), timeoutMs)
      }
      this.pending.set(request.id, pending)
      for (const presenter of presenters) {
        try {
          Promise.resolve(presenter.present(request)).catch(() => {})
        } catch {
          // One unavailable surface must not prevent another from answering.
        }
      }
    })
  }

  respond(permissionId: string, allowed: boolean): boolean {
    return this.settle(permissionId, allowed, allowed ? 'approved' : 'denied')
  }

  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.sessionId === sessionId) this.settle(id, false, 'cancelled')
    }
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, false, 'cancelled')
    this.globalPresenters.clear()
  }

  private settle(permissionId: string, allowed: boolean, resolution: PermissionResolution): boolean {
    const pending = this.pending.get(permissionId)
    if (!pending) return false
    this.pending.delete(permissionId)
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve(allowed)
    for (const presenter of pending.presenters) {
      try {
        Promise.resolve(presenter.resolve?.(pending.request, resolution)).catch(() => {})
      } catch {
        // Resolution is already final; stale surfaces are best-effort cleanup.
      }
    }
    return true
  }
}
