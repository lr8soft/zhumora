import type {
  ActionOptions,
  Desktop as TerminatorDesktop,
  Element,
  TreeBuildConfig,
  UINode
} from '@mediar-ai/terminator'
import { DesktopFrameStore, type StoredDesktopTarget } from './frameStore'
import type {
  DesktopActionRequest,
  DesktopActionResult,
  DesktopAdapter,
  DesktopApplication,
  DesktopMonitor,
  DesktopObservation,
  DesktopObserveRequest
} from './types'

const DEFAULT_MAX_DEPTH = 8
const DEFAULT_MAX_ELEMENTS = 120
const DEFAULT_TIMEOUT_MS = 5000

export class WindowsTerminatorAdapter implements DesktopAdapter {
  readonly name = 'terminator-windows'
  readonly platform = 'win32' as const

  private readonly frames = new DesktopFrameStore()
  private operationQueue: Promise<void> = Promise.resolve()

  private constructor(private readonly desktop: TerminatorDesktop) {}

  static async create(): Promise<WindowsTerminatorAdapter> {
    if (process.platform !== 'win32') {
      throw new Error(`[UNSUPPORTED_PLATFORM] Terminator adapter only supports Windows, got ${process.platform}.`)
    }
    const terminator = await import('@mediar-ai/terminator')
    const desktop = new terminator.Desktop(false, false, 'warn')
    return new WindowsTerminatorAdapter(desktop)
  }

  observe(request: DesktopObserveRequest): Promise<DesktopObservation> {
    return this.exclusive(() => this.observeInternal(request))
  }

  action(request: DesktopActionRequest): Promise<DesktopActionResult> {
    return this.exclusive(() => this.actionInternal(request))
  }

  async dispose(): Promise<void> {}

  private async observeInternal(request: DesktopObserveRequest): Promise<DesktopObservation> {
    const monitors = await this.listMonitors()
    const activeMonitorId = await this.getActiveMonitorId()
    const activeApplication = await this.getActiveApplication()

    if (request.mode === 'applications') {
      return {
        backend: this.name,
        platform: this.platform,
        frameId: this.frames.createEmptyFrame(),
        monitors,
        activeMonitorId,
        activeApplication,
        applications: this.listApplications()
      }
    }

    if (request.mode === 'screen') {
      return {
        backend: this.name,
        platform: this.platform,
        frameId: this.frames.createEmptyFrame(),
        monitors,
        activeMonitorId,
        activeApplication
      }
    }

    const processName = request.process || activeApplication?.process
    if (!processName) {
      throw new Error('[PROCESS_REQUIRED] Could not determine the active application. Call desktop_observe with mode="applications", then provide process.')
    }

    const config: TreeBuildConfig = {
      propertyMode: 'Smart' as TreeBuildConfig['propertyMode'],
      timeoutPerOperationMs: 75,
      yieldEveryNElements: 50,
      batchSize: 50,
      maxDepth: clamp(request.maxDepth ?? DEFAULT_MAX_DEPTH, 1, 30),
      uiSettleDelayMs: 100,
      formatOutput: true,
      treeOutputFormat: 'CompactYaml' as TreeBuildConfig['treeOutputFormat'],
      includeWindowScreenshot: false,
      includeMonitorScreenshots: false,
      includeGeminiVision: false,
      includeOmniparser: false,
      includeOcr: false,
      includeBrowserDom: false
    }
    const result = await this.desktop.getWindowTreeResultAsync(processName, request.title, config)
    const { frameId, targets } = this.frames.createFrame(
      processName,
      request.title,
      result.indexToBounds,
      clamp(request.maxElements ?? DEFAULT_MAX_ELEMENTS, 1, 300)
    )
    const tree = replaceTreeIndices(result.formatted || compactTree(result.tree), frameId)

    return {
      backend: this.name,
      platform: this.platform,
      frameId,
      monitors,
      activeMonitorId,
      activeApplication,
      process: processName,
      title: request.title,
      tree,
      targets,
      targetCount: result.elementCount
    }
  }

  private async actionInternal(request: DesktopActionRequest): Promise<DesktopActionResult> {
    const storedTarget = request.targetRef ? this.frames.resolve(request.targetRef) : undefined
    const processName = request.process || storedTarget?.process
    const target = await this.resolveElement(request, storedTarget, processName)
    const options: ActionOptions = {
      includeWindowScreenshot: false,
      includeMonitorScreenshots: false,
      highlightBeforeAction: false,
      tryFocusBefore: true,
      tryClickBefore: true,
      uiDiffBeforeAfter: false,
      restoreCursor: false
    }

    let details: unknown
    switch (request.action) {
      case 'click':
      case 'double_click':
      case 'right_click': {
        if (target) {
          if (request.action === 'click') details = await target.click(options)
          else if (request.action === 'double_click') details = target.doubleClick(options)
          else details = target.rightClick(options)
        } else {
          const point = requirePoint(request)
          const clickType = (request.action === 'double_click'
            ? 'Double'
            : request.action === 'right_click'
              ? 'Right'
              : 'Left') as Parameters<TerminatorDesktop['clickAtBounds']>[6]
          details = this.desktop.clickAtBounds(
            point.x,
            point.y,
            1,
            1,
            50,
            50,
            clickType,
            false,
            processName,
            false,
            false
          )
        }
        break
      }
      case 'move': {
        const point = actionPoint(request, storedTarget)
        this.desktop.root().mouseMove(point.x, point.y)
        break
      }
      case 'drag': {
        const point = actionPoint(request, storedTarget)
        if (request.endX === undefined || request.endY === undefined) {
          throw new Error('[INVALID_ARGUMENT] drag requires end_x and end_y.')
        }
        this.desktop.root().mouseDrag(point.x, point.y, request.endX, request.endY, options)
        break
      }
      case 'type': {
        const element = target || this.desktop.focusedElement()
        if (request.text === undefined) throw new Error('[INVALID_ARGUMENT] type requires text.')
        details = element.typeText(request.text, {
          clearBeforeTyping: request.clearBeforeTyping ?? false,
          includeWindowScreenshot: false,
          includeMonitorScreenshots: false,
          tryFocusBefore: true,
          tryClickBefore: true,
          uiDiffBeforeAfter: false
        })
        break
      }
      case 'key': {
        if (!request.key) throw new Error('[INVALID_ARGUMENT] key requires key.')
        details = target
          ? target.pressKey(request.key, options)
          : await this.desktop.pressKey(request.key, processName, false, false)
        break
      }
      case 'scroll': {
        const element = target || this.desktop.focusedElement()
        details = element.scroll(request.direction || 'down', request.amount ?? 3, options)
        break
      }
      case 'focus':
        requireTarget(target, request.action).focus()
        break
      case 'invoke':
        details = requireTarget(target, request.action).invoke(options)
        break
      case 'set_value':
        if (request.text === undefined) throw new Error('[INVALID_ARGUMENT] set_value requires text.')
        details = requireTarget(target, request.action).setValue(request.text, options)
        break
      case 'select_option':
        if (request.text === undefined) throw new Error('[INVALID_ARGUMENT] select_option requires text.')
        requireTarget(target, request.action).selectOption(request.text, options)
        break
      case 'set_toggled':
        if (request.toggled === undefined) throw new Error('[INVALID_ARGUMENT] set_toggled requires toggled.')
        requireTarget(target, request.action).setToggled(request.toggled, options)
        break
      default:
        throw new Error(`[INVALID_ARGUMENT] Unsupported desktop action: ${String(request.action)}`)
    }

    return {
      backend: this.name,
      success: true,
      action: request.action,
      message: `Desktop action ${request.action} completed.`,
      process: processName,
      targetRef: request.targetRef,
      details
    }
  }

  private async resolveElement(
    request: DesktopActionRequest,
    storedTarget: StoredDesktopTarget | undefined,
    processName: string | undefined
  ): Promise<Element | undefined> {
    if (!request.targetRef && !request.selector) return undefined
    if (!processName) throw new Error('[PROCESS_REQUIRED] A process is required when using target_ref or selector.')

    const selector = request.selector || storedTarget?.selector || (
      storedTarget
        ? `pos:${Math.round(storedTarget.bounds.x + storedTarget.bounds.width / 2)},${Math.round(storedTarget.bounds.y + storedTarget.bounds.height / 2)}`
        : undefined
    )
    if (!selector) throw new Error('[ELEMENT_NOT_FOUND] The target has no usable selector.')
    return this.desktop.locatorForProcess(processName, selector).first(
      clamp(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 250, 30000)
    )
  }

  private async listMonitors(): Promise<DesktopMonitor[]> {
    const monitors = await this.desktop.listMonitors()
    return monitors.map(monitor => ({
      id: monitor.id,
      name: monitor.name,
      isPrimary: monitor.isPrimary,
      bounds: { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height },
      scaleFactor: monitor.scaleFactor
    }))
  }

  private listApplications(): DesktopApplication[] {
    const applications: DesktopApplication[] = []
    for (const element of this.desktop.applications()) {
      try {
        applications.push({
          name: element.name() || element.processName(),
          process: element.processName(),
          pid: element.processId()
        })
      } catch {
        // UIA elements can disappear while the tree is being enumerated.
      }
    }
    return applications
      .filter(app => app.process)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  private async getActiveApplication(): Promise<DesktopApplication | undefined> {
    try {
      const element = await this.desktop.getCurrentApplication()
      return {
        name: element.name() || element.processName(),
        process: element.processName(),
        pid: element.processId()
      }
    } catch {
      return undefined
    }
  }

  private async getActiveMonitorId(): Promise<string | undefined> {
    try {
      return (await this.desktop.getActiveMonitor()).id
    } catch {
      return undefined
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}

function replaceTreeIndices(tree: string, frameId: string): string {
  return tree.replace(/#(\d+)\b/g, `[target_ref=${frameId}:u$1]`)
}

function compactTree(node: UINode, depth = 0): string {
  const name = node.attributes.name || node.attributes.label || ''
  const line = `${'  '.repeat(depth)}- ${node.attributes.role}${name ? `: ${name}` : ''}`
  return [line, ...node.children.map(child => compactTree(child, depth + 1))].join('\n')
}

function requirePoint(request: DesktopActionRequest): { x: number; y: number } {
  if (request.x === undefined || request.y === undefined) {
    throw new Error(`[INVALID_ARGUMENT] ${request.action} requires x and y when target_ref is not provided.`)
  }
  return { x: request.x, y: request.y }
}

function actionPoint(
  request: DesktopActionRequest,
  storedTarget: StoredDesktopTarget | undefined
): { x: number; y: number } {
  if (request.x !== undefined && request.y !== undefined) return { x: request.x, y: request.y }
  if (storedTarget) {
    return {
      x: Math.round(storedTarget.bounds.x + storedTarget.bounds.width / 2),
      y: Math.round(storedTarget.bounds.y + storedTarget.bounds.height / 2)
    }
  }
  return requirePoint(request)
}

function requireTarget(target: Element | undefined, action: string): Element {
  if (!target) throw new Error(`[INVALID_ARGUMENT] ${action} requires target_ref or process + selector.`)
  return target
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}
