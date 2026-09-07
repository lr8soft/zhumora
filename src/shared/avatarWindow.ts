export interface AvatarWindowSize { width: number; height: number }
export const DEFAULT_AVATAR_WINDOW_SIZE: Readonly<AvatarWindowSize> = { width: 360, height: 540 }
export const AVATAR_WINDOW_LIMITS = { minWidth: 240, maxWidth: 960, minHeight: 320, maxHeight: 1440 } as const

export function normalizeAvatarWindowSize(input: unknown): AvatarWindowSize {
  const raw = input && typeof input === 'object' ? input as Partial<AvatarWindowSize> : {}
  const dimension = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback
  return {
    width: dimension(raw.width, 360, AVATAR_WINDOW_LIMITS.minWidth, AVATAR_WINDOW_LIMITS.maxWidth),
    height: dimension(raw.height, 540, AVATAR_WINDOW_LIMITS.minHeight, AVATAR_WINDOW_LIMITS.maxHeight)
  }
}

interface Point { x: number; y: number }
interface Bounds extends Point, AvatarWindowSize {}
export function fitAvatarBounds(bounds: Bounds, workArea: Bounds): Bounds {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  return {
    width, height,
    x: Math.round(Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width))),
    y: Math.round(Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)))
  }
}

export type AvatarDragPhase = 'start' | 'move' | 'end'
