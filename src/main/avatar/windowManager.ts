import { BrowserWindow, screen } from 'electron'
import type {
  AvatarBootstrap,
  AvatarCapabilities,
  AvatarCommand,
  AvatarCommandEnvelope,
  AvatarModelConfig
} from '../../shared/avatar'
import { equivalentAvatarModel, normalizeAvatarLine } from '../../shared/avatar'
import type { AppSettings, Session, ToolExecutionResult } from '../../shared/types'
import type { AvatarController, AvatarMessageTarget } from './contracts'
import { AvatarAssetStore } from './assetStore'
import { generateId } from '../id'
import { log } from '../llm/logger'

interface AvatarWindowEntry {
  window: BrowserWindow
  model: AvatarModelConfig
  latestMessage: string
  capabilities: AvatarCapabilities
  ready: boolean
  readyPromise: Promise<void>
  resolveReady: () => void
}

interface AvatarWindowManagerOptions {
  preloadPath: string
  productionHtmlPath: string
  developmentUrl?: string
  assets: AvatarAssetStore
}

interface PendingCommand {
  sessionId: string
  resolve: (error?: string) => void
  timer: ReturnType<typeof setTimeout>
}

export class AvatarWindowManager implements AvatarController, AvatarMessageTarget {
  private readonly entries = new Map<string, AvatarWindowEntry>()
  private readonly pendingCommands = new Map<string, PendingCommand>()
  private readonly options: AvatarWindowManagerOptions

  constructor(options: AvatarWindowManagerOptions) {
    this.options = options
  }

  show(sessionId: string, model: AvatarModelConfig): void {
    const existing = this.entries.get(sessionId)
    if (existing && !existing.window.isDestroyed()) {
      const changed = !equivalentAvatarModel(existing.model, model)
      existing.model = structuredClone(model)
      if (changed) {
        existing.resolveReady()
        const readiness = createReadiness()
        existing.capabilities = { animations: [], expressions: [] }
        existing.ready = false
        existing.readyPromise = readiness.promise
        existing.resolveReady = readiness.resolve
        existing.window.webContents.send('avatar:state-changed')
      }
      existing.window.showInactive()
      return
    }

    const window = this.createWindow(sessionId)
    const readiness = createReadiness()
    const entry: AvatarWindowEntry = {
      window,
      model: structuredClone(model),
      latestMessage: '',
      capabilities: { animations: [], expressions: [] },
      ready: false,
      readyPromise: readiness.promise,
      resolveReady: readiness.resolve
    }
    this.entries.set(sessionId, entry)
    window.on('closed', () => {
      entry.resolveReady()
      if (this.entries.get(sessionId)?.window === window) this.entries.delete(sessionId)
      this.rejectPendingForSession(sessionId, 'Avatar window was closed.')
    })
    this.attachDiagnostics(sessionId, window)
    // The user's selection is the show action. Loading the renderer must not be
    // a hidden precondition for making the native window visible.
    window.showInactive()
    void this.loadWindow(window).catch(error => {
      log('error', `Avatar page load failed (sessionId=${sessionId}): ${formatError(error)}`)
    })
  }

  hide(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    this.entries.delete(sessionId)
    if (!entry.window.isDestroyed()) entry.window.close()
  }

  syncSessions(sessions: Session[], settings: AppSettings): void {
    const activeIds = new Set<string>()
    for (const session of sessions) {
      if (!session.avatarEnabled || !session.avatarModelId) continue
      const model = settings.avatarModels.find(candidate => candidate.id === session.avatarModelId)
      if (!model) continue
      activeIds.add(session.id)
      this.show(session.id, model)
    }
    for (const sessionId of this.entries.keys()) {
      if (!activeIds.has(sessionId)) this.hide(sessionId)
    }
  }

  async applySettings(next: AppSettings, previous: AppSettings): Promise<void> {
    for (const [sessionId, entry] of this.entries) {
      const model = next.avatarModels.find(candidate => candidate.id === entry.model.id)
      if (!model) this.hide(sessionId)
      else this.show(sessionId, model)
    }
    try {
      await this.options.assets.removeUnreferenced(previous.avatarModels, next.avatarModels)
    } catch (error) {
      // Settings are already durable at this boundary. A stale managed asset is safer than
      // making the UI report that the whole save failed after it actually succeeded.
      console.error('Avatar asset cleanup error:', error)
    }
  }

  async importModel(sourcePath: string): Promise<AvatarModelConfig> {
    return this.options.assets.importModel(sourcePath)
  }

  async importAnimation(sourcePath: string) {
    return this.options.assets.importAnimation(sourcePath)
  }

  getBootstrap(senderId: number): AvatarBootstrap {
    const [sessionId, entry] = this.entryForSender(senderId)
    return {
      sessionId,
      model: {
        id: entry.model.id,
        name: entry.model.name,
        animations: entry.model.animations.map(({ filePath: _filePath, ...animation }) => animation),
        defaultAnimationId: entry.model.defaultAnimationId
      },
      latestMessage: entry.latestMessage
    }
  }

  async getAsset(senderId: number, assetId: string): Promise<Uint8Array> {
    const [, entry] = this.entryForSender(senderId)
    if (assetId === entry.model.id) return this.options.assets.readManagedFile(entry.model.filePath)
    const animation = entry.model.animations.find(candidate => candidate.id === assetId && candidate.source === 'vrma')
    if (!animation?.filePath) throw new Error('Avatar animation asset is unavailable.')
    return this.options.assets.readManagedFile(animation.filePath)
  }

  reportCapabilities(senderId: number, capabilities: AvatarCapabilities): void {
    const [sessionId, entry] = this.entryForSender(senderId)
    const animations = cleanNames(capabilities?.animations)
    const defaultAnimation = typeof capabilities?.defaultAnimation === 'string'
      && animations.includes(capabilities.defaultAnimation)
      ? capabilities.defaultAnimation
      : undefined
    entry.capabilities = {
      animations,
      expressions: cleanNames(capabilities?.expressions),
      defaultAnimation
    }
    entry.ready = true
    entry.resolveReady()
    log('info', `Avatar renderer ready (sessionId=${sessionId})`)
  }

  resolveCommand(senderId: number, commandId: string, error?: string): void {
    const [sessionId] = this.entryForSender(senderId)
    const pending = this.pendingCommands.get(commandId)
    if (!pending || pending.sessionId !== sessionId) throw new Error('Unknown Avatar command acknowledgement.')
    clearTimeout(pending.timer)
    this.pendingCommands.delete(commandId)
    pending.resolve(typeof error === 'string' ? error.trim().slice(0, 500) : undefined)
  }

  setPointerPassthrough(senderId: number, passthrough: boolean): void {
    const [, entry] = this.entryForSender(senderId)
    if (entry.window.isDestroyed()) return
    if (passthrough) entry.window.setIgnoreMouseEvents(true, { forward: true })
    else entry.window.setIgnoreMouseEvents(false)
  }

  setMessage(sessionId: string, message: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    const normalized = normalizeAvatarLine(message)
    if (!normalized) return
    entry.latestMessage = normalized
    if (!entry.window.isDestroyed()) entry.window.webContents.send('avatar:message', normalized)
  }

  async buildSystemPrompt(sessionId: string): Promise<string> {
    let entry = this.entries.get(sessionId)
    if (!entry) return ''
    await this.waitForCapabilities(sessionId, entry)
    entry = this.entries.get(sessionId)
    if (!entry) return ''
    const animations = this.availableAnimations(entry)
    const expressions = entry.capabilities.expressions
    if (!entry.ready) {
      return [
        '## Session Avatar',
        `This session has the Avatar "${entry.model.name}" enabled, but its capability scan is not ready.`,
        'Do not guess animation or expression names. You may only use avatar_control with show_message until capabilities are available.'
      ].join('\n')
    }
    return [
      '## Session Avatar',
      `This session has the Avatar "${entry.model.name}" enabled in a separate desktop window.`,
      animations.length > 0
        ? `Available animation names (case-sensitive; use exact spelling): ${animations.join(', ')}.`
        : 'No playable animations are currently configured or embedded; do not request an animation.',
      expressions.length > 0
        ? `Available expression names (case-sensitive; use exact spelling): ${expressions.join(', ')}.`
        : 'No expression names have been reported yet.',
      entry.capabilities.defaultAnimation
        ? `The default animation "${entry.capabilities.defaultAnimation}" is already playing in a loop.`
        : 'No default animation is configured and no animation named idle was found.',
      'Never invent an animation or expression name and never change its letter case.',
      'Use avatar_control only when a motion or expression naturally reinforces the current response. It changes presentation only and never replaces task work.'
    ].join('\n')
  }

  async execute(sessionId: string | undefined, command: AvatarCommand, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (!sessionId) return { content: 'Avatar control requires a session.', isError: true }
    const entry = this.entries.get(sessionId)
    if (!entry || entry.window.isDestroyed()) {
      return { content: 'This session does not have an active Avatar window.', isError: true }
    }
    if (!entry.ready) {
      return { content: 'The Avatar window exists, but its renderer is not ready.', isError: true }
    }
    if (command.type === 'play_animation') {
      const available = this.availableAnimations(entry)
      if (!available.includes(command.animation)) {
        return { content: `Unknown Avatar animation "${command.animation}". Available: ${available.join(', ') || '(none)'}.`, isError: true }
      }
    }
    if (command.type === 'set_expression' && !entry.capabilities.expressions.includes(command.expression)) {
      return { content: `Unknown Avatar expression "${command.expression}". Available: ${entry.capabilities.expressions.join(', ') || '(none)'}.`, isError: true }
    }
    if (command.type === 'show_message') this.setMessage(sessionId, command.message)
    const error = await this.dispatchCommand(sessionId, entry, command, signal)
    return error
      ? { content: `Avatar command failed: ${error}`, isError: true }
      : { content: describeCommand(command) }
  }

  dispose(): void {
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer)
      pending.resolve('Avatar service is shutting down.')
    }
    this.pendingCommands.clear()
    for (const sessionId of [...this.entries.keys()]) this.hide(sessionId)
  }

  private availableAnimations(entry: AvatarWindowEntry): string[] {
    return cleanNames([
      ...entry.model.animations.map(animation => animation.name),
      ...entry.capabilities.animations
    ])
  }

  private async waitForCapabilities(sessionId: string, initialEntry: AvatarWindowEntry): Promise<void> {
    const deadline = Date.now() + 15_000
    let entry: AvatarWindowEntry | undefined = initialEntry
    while (entry && !entry.ready) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      await waitForPromise(entry.readyPromise, remaining)
      entry = this.entries.get(sessionId)
    }
  }

  private dispatchCommand(
    sessionId: string,
    entry: AvatarWindowEntry,
    command: AvatarCommand,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (signal?.aborted) return Promise.resolve('Command was aborted.')
    const id = generateId()
    const envelope: AvatarCommandEnvelope = { id, command }
    return new Promise(resolve => {
      const finish = (error?: string) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(error)
      }
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id)
        finish('Avatar window did not acknowledge the command in time.')
      }, 10_000)
      const onAbort = () => {
        clearTimeout(timer)
        this.pendingCommands.delete(id)
        finish('Command was aborted.')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pendingCommands.set(id, { sessionId, resolve: finish, timer })
      entry.window.webContents.send('avatar:command', envelope)
    })
  }

  private rejectPendingForSession(sessionId: string, error: string): void {
    for (const [id, pending] of this.pendingCommands) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timer)
      this.pendingCommands.delete(id)
      pending.resolve(error)
    }
  }

  private entryForSender(senderId: number): [string, AvatarWindowEntry] {
    for (const pair of this.entries) {
      if (pair[1].window.webContents.id === senderId) return pair
    }
    throw new Error('Avatar IPC request did not originate from an active Avatar window.')
  }

  private attachDiagnostics(sessionId: string, window: BrowserWindow): void {
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

  private createWindow(sessionId: string): BrowserWindow {
    const workArea = screen.getPrimaryDisplay().workArea
    const index = this.entries.size
    const width = 360
    const height = 540
    const window = new BrowserWindow({
      width,
      height,
      minWidth: 260,
      minHeight: 360,
      x: Math.max(workArea.x, workArea.x + workArea.width - width - 24 - index * 28),
      y: Math.max(workArea.y, workArea.y + workArea.height - height - 24 - index * 28),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      title: `Zhumora Avatar — ${sessionId}`,
      webPreferences: {
        preload: this.options.preloadPath,
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

  private loadWindow(window: BrowserWindow): Promise<void> {
    if (this.options.developmentUrl) {
      const base = this.options.developmentUrl.endsWith('/')
        ? this.options.developmentUrl
        : `${this.options.developmentUrl}/`
      return window.loadURL(new URL('avatar.html', base).toString())
    }
    return window.loadFile(this.options.productionHtmlPath)
  }
}

function cleanNames(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().slice(0, 120))
    .filter(Boolean))]
}

function describeCommand(command: AvatarCommand): string {
  switch (command.type) {
    case 'play_animation': return `Avatar animation "${command.animation}" started (${command.loop ? 'loop' : 'once'}).`
    case 'set_expression': return `Avatar expression "${command.expression}" set to ${command.value}.`
    case 'reset_pose': return 'Avatar pose and expressions reset.'
    case 'show_message': return 'Avatar message updated.'
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createReadiness(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function waitForPromise(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    promise,
    new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })
  ])
  if (timer) clearTimeout(timer)
}
