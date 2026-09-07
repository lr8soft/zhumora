import { BrowserWindow, screen } from 'electron'
import type { AvatarCommand } from '../../shared/avatar'
import { fitAvatarBounds, type AvatarWindowSize } from '../../shared/avatarWindow'
import { log } from '../llm/logger'

export interface AvatarWindowPaths {
  preloadPath: string
  productionHtmlPath: string
  developmentUrl?: string
}

export function attachDiagnostics(sessionId: string, window: BrowserWindow): void {
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('error', `Avatar preload failed (sessionId=${sessionId}, path=${preloadPath}): ${formatError(error)}`)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return
    log('error', `Avatar renderer failed to load (sessionId=${sessionId}, code=${code}, url=${url}): ${description}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    log('error', `Avatar renderer exited (sessionId=${sessionId}, reason=${details.reason}, code=${details.exitCode})`)
  })
}

export function createAvatarWindow(sessionId: string, index: number, options: AvatarWindowPaths, size: AvatarWindowSize): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workArea
  const { width, height } = size
  const bounds = fitAvatarBounds({ width, height,
    x: workArea.x + workArea.width - width - 24 - index * 28,
    y: workArea.y + workArea.height - height - 24 - index * 28
  }, workArea)
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    title: `Zhumora Avatar — ${sessionId}`,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // Transparent pixels still participate in native hit-testing. Default the
  // overlay to click-through; the renderer enables input only over visible UI.
  window.setIgnoreMouseEvents(true, { forward: true })
  return window
}

export function loadAvatarWindow(window: BrowserWindow, options: AvatarWindowPaths): Promise<void> {
  if (options.developmentUrl) {
    const base = options.developmentUrl.endsWith('/')
      ? options.developmentUrl
      : `${options.developmentUrl}/`
    return window.loadURL(new URL('avatar.html', base).toString())
  }
  return window.loadFile(options.productionHtmlPath)
}

export function cleanNames(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().slice(0, 120))
    .filter(Boolean))]
}

export function describeCommand(command: AvatarCommand): string {
  switch (command.type) {
    case 'perform': return `Avatar ${command.intent} scheduled; automatically returns to current activity.`
    case 'play_animation': return `Avatar animation "${command.animation}" started (${command.loop ? 'loop' : 'once'}).`
    case 'set_expression': return `Avatar expression "${command.expression}" set to ${command.value}.`
    case 'reset_pose': return 'Avatar pose and expressions reset.'
    case 'show_message': return 'Avatar message updated.'
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createReadiness(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

export async function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    promise,
    new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })
  ])
  if (timer) clearTimeout(timer)
}
