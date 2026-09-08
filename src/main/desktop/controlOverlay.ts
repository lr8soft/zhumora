import { BrowserWindow, screen } from 'electron'
import type { DesktopControlIndicator } from './controlCoordinator'

export class DesktopControlOverlay implements DesktopControlIndicator {
  private windows: BrowserWindow[] = []
  private sessionId?: string
  private generation = 0
  private readonly getTitle: (id: string) => string
  private readonly onDisplaysChanged = () => { this.hide() }

  constructor(getTitle: (id: string) => string) {
    this.getTitle = getTitle
    screen.on('display-added', this.onDisplaysChanged)
    screen.on('display-removed', this.onDisplaysChanged)
    screen.on('display-metrics-changed', this.onDisplaysChanged)
  }

  async show(sessionId: string): Promise<void> {
    if (this.sessionId === sessionId && this.windows.every(win => !win.isDestroyed())) return
    this.hide()
    this.sessionId = sessionId
    const generation = this.generation
    const title = escapeHtml(this.getTitle(sessionId).slice(0, 60))
    await Promise.all(screen.getAllDisplays().map(async display => {
      const win = new BrowserWindow({
        ...display.bounds, show: false, transparent: true, frame: false,
        focusable: false, skipTaskbar: true, alwaysOnTop: true, resizable: false,
        hasShadow: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      this.windows.push(win)
      win.setIgnoreMouseEvents(true)
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setContentProtection(true)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
        *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
        body{border:3px solid #50c9ee;border-radius:8px;box-shadow:inset 0 0 12px #50c9ee55;font:14px system-ui;color:white}
        span{position:absolute;top:0;left:50%;transform:translateX(-50%);max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#124657;padding:6px 18px;border-radius:0 0 10px 10px}
        </style></head><body><span>AI 正在操作 · ${title}</span></body></html>`
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      if (generation === this.generation && !win.isDestroyed()) win.showInactive()
    }))
  }

  hide(): void {
    this.generation++
    this.sessionId = undefined
    for (const win of this.windows) if (!win.isDestroyed()) win.destroy()
    this.windows = []
  }

  dispose(): void {
    this.hide()
    screen.removeListener('display-added', this.onDisplaysChanged)
    screen.removeListener('display-removed', this.onDisplaysChanged)
    screen.removeListener('display-metrics-changed', this.onDisplaysChanged)
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}
