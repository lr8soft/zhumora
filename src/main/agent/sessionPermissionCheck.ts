import type { PermissionBroker, PermissionCheckOptions } from './permissionBroker.ts'
import { isSubagentStartTool } from './subagentPolicy.ts'

interface RunPermissionOptions extends PermissionCheckOptions {
  signal: AbortSignal
  isCurrent: () => boolean
  subagentsEnabled: () => boolean
}

/** Recheck live policy after human approval: disabling delegation cannot be bypassed by a stale allow. */
export function createSessionPermissionCheck(broker: PermissionBroker, options: RunPermissionOptions) {
  const check = broker.createCheck(options)
  const canExecute = (name: string): boolean => !options.signal.aborted && options.isCurrent()
    && (!isSubagentStartTool(name) || options.subagentsEnabled())
  return async (name: string, args: Record<string, unknown>): Promise<boolean> => {
    if (!canExecute(name)) return false
    return await check(name, args) && canExecute(name)
  }
}
