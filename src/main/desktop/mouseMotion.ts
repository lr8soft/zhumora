import type {
  DesktopBounds,
  DesktopMouseEasing,
  DesktopPoint,
  DesktopTargetAnchor
} from './types'

const FRAME_MS = 16
const MAX_STEPS = 120

export function pointInBounds(
  bounds: DesktopBounds,
  anchor: DesktopTargetAnchor = 'center'
): DesktopPoint {
  const positions: Record<DesktopTargetAnchor, [number, number]> = {
    center: [0.5, 0.5],
    top: [0.5, 0.2],
    bottom: [0.5, 0.8],
    left: [0.2, 0.5],
    right: [0.8, 0.5]
  }
  const [xRatio, yRatio] = positions[anchor]
  return {
    x: Math.round(bounds.x + bounds.width * xRatio),
    y: Math.round(bounds.y + bounds.height * yRatio)
  }
}

export function buildMousePath(
  start: DesktopPoint,
  end: DesktopPoint,
  durationMs: number,
  easing: DesktopMouseEasing = 'ease_out'
): DesktopPoint[] {
  if (durationMs <= 0) return [{ ...end }]
  const steps = Math.max(1, Math.min(MAX_STEPS, Math.ceil(durationMs / FRAME_MS)))
  const points: DesktopPoint[] = []

  for (let index = 1; index <= steps; index++) {
    const progress = ease(index / steps, easing)
    const point = {
      x: Math.round(start.x + (end.x - start.x) * progress),
      y: Math.round(start.y + (end.y - start.y) * progress)
    }
    const previous = points.at(-1)
    if (!previous || previous.x !== point.x || previous.y !== point.y) points.push(point)
  }

  const last = points.at(-1)
  if (!last || last.x !== end.x || last.y !== end.y) points.push({ ...end })
  return points
}

export async function moveMouse(
  move: (x: number, y: number) => void,
  start: DesktopPoint | undefined,
  end: DesktopPoint,
  durationMs = 0,
  easing: DesktopMouseEasing = 'ease_out'
): Promise<void> {
  if (!start || durationMs <= 0) {
    move(end.x, end.y)
    return
  }

  const path = buildMousePath(start, end, durationMs, easing)
  const intervalMs = durationMs / path.length
  for (const point of path) {
    await delay(intervalMs)
    move(point.x, point.y)
  }
}

function ease(progress: number, easing: DesktopMouseEasing): number {
  if (easing === 'linear') return progress
  if (easing === 'ease_in_out') {
    return progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2
  }
  return 1 - Math.pow(1 - progress, 3)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
