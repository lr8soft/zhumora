import type { DesktopBounds } from './types'

export interface ScreenshotCoordinateFrame {
  frameId: string
  imageWidth: number
  imageHeight: number
  screenBounds: DesktopBounds
}

export interface DipDisplayFrame {
  bounds: DesktopBounds
  scaleFactor: number
}

export function displayPointToPhysical(
  display: DipDisplayFrame,
  point: { x: number; y: number }
): { x: number; y: number } {
  const scale = display.scaleFactor || 1
  const physicalOrigin = {
    x: Math.round(display.bounds.x * scale),
    y: Math.round(display.bounds.y * scale)
  }
  return {
    x: Math.round(physicalOrigin.x + (point.x - display.bounds.x) * scale),
    y: Math.round(physicalOrigin.y + (point.y - display.bounds.y) * scale)
  }
}

export function screenshotPointToScreen(
  frame: ScreenshotCoordinateFrame,
  x: number,
  y: number
): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('[INVALID_COORDINATES] x and y must be finite numbers.')
  }
  if (x < 0 || y < 0 || x > frame.imageWidth || y > frame.imageHeight) {
    throw new Error(
      `[INVALID_COORDINATES] Point (${x}, ${y}) is outside screenshot ${frame.imageWidth}x${frame.imageHeight}.`
    )
  }
  return {
    x: Math.round(frame.screenBounds.x + (x / frame.imageWidth) * frame.screenBounds.width),
    y: Math.round(frame.screenBounds.y + (y / frame.imageHeight) * frame.screenBounds.height)
  }
}
