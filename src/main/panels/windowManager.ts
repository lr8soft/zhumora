import { shell, type BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { isPanelId, isPanelTicketKey, isPanelWindowAction, type PanelId, type PanelWindowTicket } from '../../shared/panels'
import { decideNavigation } from '../navigationPolicy'

interface Ticket { owner: WebContents; panelId: PanelId; expires: number; accepted: boolean }
interface Child { owner: WebContents; window: BrowserWindow }

/** Owns presentation windows only. Their React portals share the existing renderer projection and event subscription. */
export class PanelWindowManager {
  private owner: BrowserWindow | null = null
  private tickets = new Map<string, Ticket>()
  private windows = new Map<string, Child>()
  private throttlingBeforePanels: boolean | null = null

  constructor(private readonly showWindows = true) {}

  attach(owner: BrowserWindow): void {
    this.dispose()
    this.owner = owner
    owner.webContents.on('did-create-window', (window, details) => this.accept(window, details.frameName))
    owner.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace && this.owner === owner) this.closeAll()
    })
    owner.webContents.once('destroyed', () => { if (this.owner === owner) this.dispose() })
  }

  prepare(sender: WebContents, panelId: unknown): PanelWindowTicket {
    if (sender !== this.owner?.webContents || sender.isDestroyed() || !isPanelId(panelId)) throw new Error('Invalid panel owner or panel')
    for (const [key, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(key)
    if (this.tickets.size + this.windows.size >= 8) throw new Error('Too many panel windows')
    const key = `zhumora-panel-${randomUUID()}`
    this.tickets.set(key, { owner: sender, panelId, expires: Date.now() + 30_000, accepted: false })
    return { key }
  }

  allow(sender: WebContents, details: { url: string; frameName: string }): Electron.WindowOpenHandlerResponse | null {
    const ticket = this.tickets.get(details.frameName)
    if (details.url !== 'about:blank' || !ticket || ticket.accepted || ticket.expires < Date.now() || ticket.owner !== sender) return null
    ticket.accepted = true
    return { action: 'allow', overrideBrowserWindowOptions: {
      width: ticket.panelId === 'conversation' ? 1100 : 520, height: 760, minWidth: 360, minHeight: 300,
      show: this.showWindows, frame: false, autoHideMenuBar: true, title: 'Zhumora', backgroundColor: '#202124',
      // about:blank inherits its opener's preferences. Matching sandbox preserves scriptable same-origin portals;
      // it grants no Node access and never permits arbitrary URLs or renderer-selected preloads.
      webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false, webviewTag: false }
    } }
  }

  control(sender: WebContents, key: unknown, action: unknown): boolean {
    if (!isPanelTicketKey(key) || !isPanelWindowAction(action)) throw new Error('Invalid panel control')
    const child = this.windows.get(key)
    if (!child || child.owner !== sender || child.window.isDestroyed()) return false
    if (action === 'close') child.window.close()
    else if (action === 'minimize') child.window.minimize()
    else if (child.window.isMaximized()) child.window.unmaximize()
    else child.window.maximize()
    return true
  }

  dispose(): void {
    this.closeAll()
    this.owner = null
  }

  private closeAll(): void {
    for (const child of this.windows.values()) if (!child.window.isDestroyed()) child.window.destroy()
    this.windows.clear()
    this.tickets.clear()
    this.restoreThrottling()
  }

  private accept(window: BrowserWindow, key: string): void {
    const ticket = this.tickets.get(key)
    this.tickets.delete(key)
    if (!ticket?.accepted || ticket.owner.isDestroyed()) { window.destroy(); return }
    if (!this.windows.size) this.throttlingBeforePanels = ticket.owner.getBackgroundThrottling()
    ticket.owner.setBackgroundThrottling(false)
    this.windows.set(key, { owner: ticket.owner, window })
    window.on('closed', () => {
      this.windows.delete(key)
      if (!this.windows.size) this.restoreThrottling()
      if (!ticket.owner.isDestroyed()) ticket.owner.send('panels:closed', { key })
    })
    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (decideNavigation(url, '') === 'external') void shell.openExternal(url)
    })
    window.webContents.setWindowOpenHandler(details => {
      if (decideNavigation(details.url, '') === 'external') void shell.openExternal(details.url)
      return { action: 'deny' }
    })
  }

  private restoreThrottling(): void {
    if (this.throttlingBeforePanels !== null && this.owner && !this.owner.isDestroyed() && !this.owner.webContents.isDestroyed()) {
      this.owner.webContents.setBackgroundThrottling(this.throttlingBeforePanels)
    }
    this.throttlingBeforePanels = null
  }
}
