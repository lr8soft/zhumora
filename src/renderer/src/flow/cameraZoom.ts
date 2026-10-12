export const CAMERA_ZOOM = { min: .08, max: 1.8 } as const

export function clampCameraZoom(zoom: number): number {
  return Math.max(CAMERA_ZOOM.min, Math.min(CAMERA_ZOOM.max, zoom))
}

export function centerAtZoom(bounds: { x: number; y: number; width: number; height: number },
  width: number, height: number, zoom: number) {
  const scale = clampCameraZoom(zoom)
  return { x: width / 2 - (bounds.x + bounds.width / 2) * scale,
    y: height / 2 - (bounds.y + bounds.height / 2) * scale, zoom: scale }
}

export function isZoomGesture(event: { type: string; touches?: { length: number } }): boolean {
  return event.type === 'wheel' || (event.touches?.length ?? 0) > 1
}
