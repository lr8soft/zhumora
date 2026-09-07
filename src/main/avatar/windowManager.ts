import { BrowserWindow, screen } from 'electron'
import type {
  AvatarBootstrap,
  AvatarActivity,
  AvatarCapabilities,
  AvatarCommand,
  AvatarCommandEnvelope,
  AvatarLookTarget,
  AvatarModelConfig
} from '../../shared/avatar'
import { AVATAR_INTENTS, equivalentAvatarModel, normalizeAvatarLine } from '../../shared/avatar'
import type { AppSettings, Session, ToolExecutionResult } from '../../shared/types'
import type { AvatarController, AvatarMessageTarget } from './contracts'
import { AvatarAssetStore } from './assetStore'
import { generateId } from '../id'
import { log } from '../llm/logger'
import { buildAvatarSystemPrompt } from './prompt'
import { mapScreenPointToAvatarLookTarget } from './lookTarget'
import { DEFAULT_AVATAR_WINDOW_SIZE, type AvatarDragPhase, type AvatarWindowSize } from '../../shared/avatarWindow'
import { AvatarWindowInteraction } from './windowInteraction'
import { attachDiagnostics, createAvatarWindow, loadAvatarWindow, cleanNames, describeCommand, formatError, createReadiness, waitForPromise } from './windowSupport'

interface AvatarWindowEntry {
  window: BrowserWindow
  model: AvatarModelConfig
  latestMessage: string
  capabilities: AvatarCapabilities
  ready: boolean
  readyPromise: Promise<void>
  resolveReady: () => void
  pointerInside: boolean
  activity: AvatarActivity
  interaction: AvatarWindowInteraction
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
  private lookTrackingTimer: ReturnType<typeof setInterval> | undefined
  private windowSize: AvatarWindowSize = { ...DEFAULT_AVATAR_WINDOW_SIZE }

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
      this.startLookTracking()
      return
    }

    const window = createAvatarWindow(sessionId, this.entries.size, this.options, this.windowSize)
    const readiness = createReadiness()
    const entry: AvatarWindowEntry = {
      window,
      model: structuredClone(model),
      latestMessage: '',
      capabilities: { animations: [], expressions: [] },
      ready: false,
      readyPromise: readiness.promise,
      resolveReady: readiness.resolve,
      pointerInside: false,
      activity: 'idle',
      interaction: new AvatarWindowInteraction(window, {
        cursor: () => screen.getCursorScreenPoint(),
        workArea: bounds => screen.getDisplayMatching(bounds).workArea
      })
    }
    this.entries.set(sessionId, entry)
    this.startLookTracking()
    window.on('closed', () => {
      entry.resolveReady()
      if (this.entries.get(sessionId)?.window === window) this.entries.delete(sessionId)
      this.rejectPendingForSession(sessionId, 'Avatar window was closed.')
      this.stopLookTrackingIfIdle()
    })
    attachDiagnostics(sessionId, window)
    // The user's selection is the show action. Loading the renderer must not be
    // a hidden precondition for making the native window visible.
    window.showInactive()
    void loadAvatarWindow(window, this.options).catch(error => {
      log('error', `Avatar page load failed (sessionId=${sessionId}): ${formatError(error)}`)
    })
  }

  hide(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    this.entries.delete(sessionId)
    if (!entry.window.isDestroyed()) entry.window.close()
    this.stopLookTrackingIfIdle()
  }

  syncSessions(sessions: Session[], settings: AppSettings): void {
    this.applyWindowSize(settings.avatarWindowSize)
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
    this.applyWindowSize(next.avatarWindowSize)
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
      latestMessage: entry.latestMessage,
      activity: entry.activity
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
      defaultAnimation,
      intents: AVATAR_INTENTS.filter(intent => capabilities?.intents?.includes(intent))
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
    entry.interaction.setPassthrough(passthrough)
  }

  drag(senderId: number, phase: AvatarDragPhase): void {
    this.entryForSender(senderId)[1].interaction.drag(phase)
  }

  private applyWindowSize(size: AvatarWindowSize): void {
    if (this.windowSize.width === size.width && this.windowSize.height === size.height) return
    this.windowSize = { ...size }
    for (const entry of this.entries.values()) entry.interaction.resize(size)
  }

  setMessage(sessionId: string, message: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    const normalized = normalizeAvatarLine(message)
    if (!normalized) return
    entry.latestMessage = normalized
    if (!entry.window.isDestroyed()) entry.window.webContents.send('avatar:message', normalized)
  }

  setActivity(sessionId: string, activity: AvatarActivity): void {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.activity === activity || entry.window.isDestroyed()) return
    entry.activity = activity
    entry.window.webContents.send('avatar:activity', activity)
  }

  async buildSystemPrompt(sessionId: string): Promise<string> {
    let entry = this.entries.get(sessionId)
    if (!entry) return ''
    await this.waitForCapabilities(sessionId, entry)
    entry = this.entries.get(sessionId)
    if (!entry) return ''
    const animations = this.availableAnimations(entry)
    return buildAvatarSystemPrompt(entry.model.name, animations, entry.capabilities, entry.ready)
  }

  async execute(sessionId: string | undefined, command: AvatarCommand, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (signal?.aborted) return { content: 'Avatar command was aborted.', isError: true }
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
    if (command.type === 'perform' && !entry.capabilities.intents?.includes(command.intent)) {
      return { content: 'This Avatar renderer does not support that intent.', isError: true }
    }
    if (command.type === 'set_expression') {
      const requested = command.expression.toLowerCase()
      const matches = entry.capabilities.expressions.filter(name => name.toLowerCase() === requested)
      if (!entry.capabilities.expressions.includes(command.expression) && matches.length === 1) command = { ...command, expression: matches[0] }
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
    this.stopLookTracking()
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer)
      pending.resolve('Avatar service is shutting down.')
    }
    this.pendingCommands.clear()
    for (const sessionId of [...this.entries.keys()]) this.hide(sessionId)
  }

  private availableAnimations(entry: AvatarWindowEntry): string[] {
    return [...entry.capabilities.animations]
  }

  private startLookTracking(): void {
    if (this.lookTrackingTimer) return
    this.lookTrackingTimer = setInterval(() => this.publishLookTargets(), 50)
  }

  private stopLookTrackingIfIdle(): void {
    if (this.entries.size === 0) this.stopLookTracking()
  }

  private stopLookTracking(): void {
    if (!this.lookTrackingTimer) return
    clearInterval(this.lookTrackingTimer)
    this.lookTrackingTimer = undefined
  }

  private publishLookTargets(): void {
    const cursor = screen.getCursorScreenPoint()
    for (const entry of this.entries.values()) {
      if (entry.window.isDestroyed() || !entry.ready) continue
      const bounds = entry.window.getBounds()
      const target = mapScreenPointToAvatarLookTarget(cursor, bounds)
      if (!target) {
        if (entry.pointerInside) {
          entry.pointerInside = false
          entry.window.webContents.send('avatar:look-target', { x: 0, y: 0, tracking: false } satisfies AvatarLookTarget)
        }
        continue
      }
      entry.pointerInside = true
      entry.window.webContents.send('avatar:look-target', { ...target, tracking: true } satisfies AvatarLookTarget)
    }
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

}
