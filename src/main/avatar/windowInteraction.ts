import type { BrowserWindow } from 'electron'
import { fitAvatarBounds, type AvatarDragPhase, type AvatarWindowSize } from '../../shared/avatarWindow.ts'

interface Point { x: number; y: number }
interface Bounds extends Point, AvatarWindowSize {}
interface DisplayGeometry {
  cursor(): Point
  workArea(bounds: Bounds): Bounds
}
type Window = Pick<BrowserWindow, 'getBounds' | 'setBounds' | 'setIgnoreMouseEvents' | 'isDestroyed' | 'on' | 'removeListener'>

/** A window owns its drag state. Coordinates come from Electron in DIP, not IPC. */
export class AvatarWindowInteraction {
  private readonly window: Window
  private readonly display: DisplayGeometry
  private origin: { pointer: Point; bounds: Bounds } | undefined

  constructor(window: Window, display: DisplayGeometry) {
    this.window = window
    this.display = display
    window.on('blur', this.cancel)
    window.on('closed', this.dispose)
  }

  drag(phase: AvatarDragPhase): void {
    if (this.window.isDestroyed()) return
    if (phase === 'end') { this.cancel(); return }
    if (phase === 'start') {
      this.origin = { pointer: this.display.cursor(), bounds: this.window.getBounds() }
      this.window.setIgnoreMouseEvents(false)
      return
    }
    if (!this.origin) return
    const pointer = this.display.cursor()
    const proposed = {
      ...this.origin.bounds,
      x: this.origin.bounds.x + pointer.x - this.origin.pointer.x,
      y: this.origin.bounds.y + pointer.y - this.origin.pointer.y
    }
    this.window.setBounds(fitAvatarBounds(proposed, this.display.workArea({ ...proposed, x: pointer.x, y: pointer.y, width: 1, height: 1 })))
  }

  resize(size: AvatarWindowSize): void {
    if (this.window.isDestroyed()) return
    this.cancel()
    const bounds = this.window.getBounds()
    this.window.setBounds(fitAvatarBounds({ ...bounds, ...size }, this.display.workArea(bounds)))
  }

  setPassthrough(passthrough: boolean): void {
    if (this.window.isDestroyed() || this.origin) return
    this.window.setIgnoreMouseEvents(passthrough, { forward: true })
  }

  private cancel = (): void => {
    this.origin = undefined
    this.setPassthrough(true)
  }

  dispose = (): void => {
    this.origin = undefined
    this.window.removeListener('blur', this.cancel)
    this.window.removeListener('closed', this.dispose)
  }
}
