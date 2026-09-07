import type { AvatarLookTarget } from '../../shared/avatar'

interface ScreenPoint {
  x: number
  y: number
}

interface ScreenBounds extends ScreenPoint {
  width: number
  height: number
}

export function isScreenPointInsideBounds(cursor: ScreenPoint, bounds: ScreenBounds): boolean {
  return cursor.x >= bounds.x
    && cursor.x < bounds.x + bounds.width
    && cursor.y >= bounds.y
    && cursor.y < bounds.y + bounds.height
}

export function mapScreenPointToAvatarLookTarget(
  cursor: ScreenPoint,
  bounds: ScreenBounds
): AvatarLookTarget | undefined {
  if (bounds.width <= 0 || bounds.height <= 0 || !isScreenPointInsideBounds(cursor, bounds)) return undefined
  return {
    x: ((cursor.x - bounds.x) / bounds.width) * 2 - 1,
    y: 1 - ((cursor.y - bounds.y) / bounds.height) * 2
  }
}
