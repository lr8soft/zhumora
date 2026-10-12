import type { PanelId } from '../../../shared/panels.ts'

export type DockSide = 'left' | 'right' | 'top' | 'bottom' | 'center'
export type PanelMode = DockSide | 'floating' | 'window'
export interface PanelBounds { x: number; y: number; width: number; height: number }
export interface PanelPlacement { mode: PanelMode; home: DockSide; bounds: PanelBounds }
export type PanelLayout = Record<PanelId, PanelPlacement>
export const DOCK_SIDES: readonly DockSide[] = ['left', 'right', 'top', 'bottom', 'center']

export function initialPanelLayout(): PanelLayout {
  return {
    conversation: { mode: 'center', home: 'center', bounds: { x: 24, y: 24, width: 900, height: 540 } },
    details: { mode: 'right', home: 'right', bounds: { x: 70, y: 50, width: 420, height: 540 } },
    composer: { mode: 'bottom', home: 'bottom', bounds: { x: 100, y: 240, width: 680, height: 260 } }
  }
}

export function placePanel(layout: PanelLayout, id: PanelId, mode: PanelMode, bounds?: PanelBounds): PanelLayout {
  return { ...layout, [id]: { ...layout[id], mode, home: DOCK_SIDES.includes(mode as DockSide) ? mode as DockSide : layout[id].home,
    bounds: bounds ?? layout[id].bounds } }
}

export function constrainPanel(bounds: PanelBounds, size: { width: number; height: number }): PanelBounds {
  const width = Math.min(size.width, Math.max(220, bounds.width))
  const height = Math.min(size.height, Math.max(160, bounds.height))
  return { width, height, x: Math.max(0, Math.min(bounds.x, size.width - width)), y: Math.max(0, Math.min(bounds.y, size.height - height)) }
}

export function dockTargetAt(x: number, y: number, size: { width: number; height: number }): DockSide | null {
  if (x < 0 || y < 0 || x > size.width || y > size.height) return null
  if (x < 36) return 'left'
  if (x > size.width - 36) return 'right'
  if (y < 36) return 'top'
  if (y > size.height - 36) return 'bottom'
  const dx = x - size.width / 2, dy = y - size.height / 2
  if (Math.abs(dx) < 26 && Math.abs(dy) < 26) return 'center'
  if (Math.abs(dx + 66) < 26 && Math.abs(dy) < 26) return 'left'
  if (Math.abs(dx - 66) < 26 && Math.abs(dy) < 26) return 'right'
  if (Math.abs(dx) < 26 && Math.abs(dy + 66) < 26) return 'top'
  if (Math.abs(dx) < 26 && Math.abs(dy - 66) < 26) return 'bottom'
  return null
}
