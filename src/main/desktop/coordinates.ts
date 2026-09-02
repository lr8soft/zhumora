import type { DesktopBounds } from './types'

export interface ScreenshotCoordinateFrame {
  frameId: string
  imageWidth: number
  imageHeight: number
  screenBounds: DesktopBounds
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
