import type { AutoApproveMode } from '../../shared/types'
import type { PermissionLevel } from '../tools/registry'

export type PermissionDecision = 'allow' | 'confirm'

/** Pure three-tier policy shared by desktop and every bot adapter. */
export function decidePermission(
  mode: AutoApproveMode,
  level: PermissionLevel,
  alwaysConfirm: boolean
): PermissionDecision {
  if (alwaysConfirm) return 'confirm'
  if (level === 'safe') return 'allow'
  if (mode === 'full') return 'allow'
  if (mode === 'auto' && level === 'normal') return 'allow'
  return 'confirm'
}
