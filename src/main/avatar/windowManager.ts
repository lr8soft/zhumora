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

interface AvatarWindowEntry {
  window: BrowserWindow
  model: AvatarModelConfig
  latestMessage: string
  capabilities: AvatarCapabilities
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
        existing.capabilities = { animations: [], expressions: [] }
        existing.window.webContents.send('avatar:state-changed')
      }
      existing.window.showInactive()
      return
    }

    const window = this.createWindow(sessionId)
    const entry: AvatarWindowEntry = {
      window,
      model: structuredClone(model),
      latestMessage: '',
      capabilities: { animations: [], expressions: [] }
    }
    this.entries.set(sessionId, entry)
    window.on('closed', () => {
      if (this.entries.get(sessionId)?.window === window) this.entries.delete(sessionId)
      this.rejectPendingForSession(sessionId, 'Avatar window was closed.')
    })
    window.webContents.once('did-finish-load', () => window.showInactive())
    void this.loadWindow(window)
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
        animations: entry.model.animations.map(({ filePath: _filePath, ...animation }) => animation)
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
    const [, entry] = this.entryForSender(senderId)
    entry.capabilities = {
      animations: cleanNames(capabilities?.animations),
      expressions: cleanNames(capabilities?.expressions)
    }
  }

  resolveCommand(senderId: number, commandId: string, error?: string): void {
    const [sessionId] = this.entryForSender(senderId)
    const pending = this.pendingCommands.get(commandId)
    if (!pending || pending.sessionId !== sessionId) throw new Error('Unknown Avatar command acknowledgement.')
    clearTimeout(pending.timer)
    this.pendingCommands.delete(commandId)
    pending.resolve(typeof error === 'string' ? error.trim().slice(0, 500) : undefined)
  }

  setMessage(sessionId: string, message: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    const normalized = normalizeAvatarLine(message)
    if (!normalized) return
    entry.latestMessage = normalized
    if (!entry.window.isDestroyed()) entry.window.webContents.send('avatar:message', normalized)
  }

  buildSystemPrompt(sessionId: string): string {
    const entry = this.entries.get(sessionId)
    if (!entry) return ''
    const animations = this.availableAnimations(entry)
    const expressions = entry.capabilities.expressions
    return [
      '## Session Avatar',
      `This session has the Avatar "${entry.model.name}" enabled in a separate desktop window.`,
      animations.length > 0
        ? `Available animation names (use exact spelling): ${animations.join(', ')}.`
        : 'No playable animations are currently configured or embedded; do not request an animation.',
      expressions.length > 0
        ? `Available expression names (use exact spelling): ${expressions.join(', ')}.`
        : 'No expression names have been reported yet.',
      'Use avatar_control only when a motion or expression naturally reinforces the current response. It changes presentation only and never replaces task work.'
    ].join('\n')
  }

  async execute(sessionId: string | undefined, command: AvatarCommand, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (!sessionId) return { content: 'Avatar control requires a session.', isError: true }
    const entry = this.entries.get(sessionId)
    if (!entry || entry.window.isDestroyed()) {
      return { content: 'This session does not have an active Avatar window.', isError: true }
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

  private createWindow(sessionId: string): BrowserWindow {
    const workArea = screen.getPrimaryDisplay().workArea
    const index = this.entries.size
    const width = 360
    const height = 540
    return new BrowserWindow({
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
