import { desktopCapturer, screen as electronScreen } from 'electron'
import type { Display } from 'electron'
import { getDesktopAdapter } from '../desktop/adapter'
import { screenshotPointToScreen, type ScreenshotCoordinateFrame } from '../desktop/coordinates'
import type {
  DesktopActionName,
  DesktopActionRequest,
  DesktopMonitor,
  DesktopObservation,
  DesktopObserveMode
} from '../desktop/types'
import type { ToolHandler } from './registry'

export const DESKTOP_OBSERVE_TOOL_NAME = 'desktop_observe'
export const DESKTOP_ACTION_TOOL_NAME = 'desktop_action'

const MAX_IMAGE_WIDTH = 1280
const SCREENSHOT_FRAME_TTL_MS = 2 * 60 * 1000
const MAX_SCREENSHOT_FRAMES = 16

interface CapturedDisplay {
  base64: string
  frame: ScreenshotCoordinateFrame
  displayId: string
  displayName: string
  scaleFactor: number
}

const screenshotFrames = new Map<string, { createdAt: number; frame: ScreenshotCoordinateFrame }>()
let screenshotSequence = 0

export const desktopObserveTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: DESKTOP_OBSERVE_TOOL_NAME,
      description:
        'Observe the Windows desktop through the Terminator accessibility adapter. Returns application/window structure with stable target_ref values and can attach a screenshot. Call this again when a target_ref is stale.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['applications', 'screen', 'window'],
            description: 'applications lists apps; screen captures display state; window returns the UI accessibility tree for a process.'
          },
          process: {
            type: 'string',
            description: 'Executable/process name for mode=window, for example notepad.exe. Defaults to the active app when detectable.'
          },
          title: { type: 'string', description: 'Optional window title filter.' },
          display_id: { type: 'string', description: 'Optional display id. Defaults to the active or primary display.' },
          include_screenshot: {
            type: 'boolean',
            description: 'Attach a screenshot. Defaults to true except in applications mode.'
          },
          max_depth: { type: 'number', description: 'Maximum accessibility-tree depth, 1-30. Default 8.' },
          max_elements: { type: 'number', description: 'Maximum returned target references, 1-300. Default 120.' }
        },
        required: ['mode']
      }
    }
  },
  permission: 'normal',
  async execute(args, ctx) {
    const mode = args.mode as DesktopObserveMode
    const includeScreenshot = typeof args.include_screenshot === 'boolean'
      ? args.include_screenshot
      : mode !== 'applications'

    // A plain screenshot must never wait on UI Automation. Electron owns this
    // path entirely, so even a wedged Terminator process cannot block capture.
    if (mode === 'screen') {
      if (!includeScreenshot) return JSON.stringify(createElectronScreenObservation(), null, 2)
      const capture = await captureDisplay(undefined, optionalString(args.display_id), undefined, ctx.signal)
      const observation = createElectronScreenObservation(capture.frame.frameId, capture.displayId)
      return formatImageResult(capture, {
        observation,
        screenshot: screenshotMetadata(capture)
      })
    }

    const adapter = await getDesktopAdapter()
    const observation = await adapter.observe({
      mode,
      process: optionalString(args.process),
      title: optionalString(args.title),
      maxDepth: optionalNumber(args.max_depth),
      maxElements: optionalNumber(args.max_elements)
    }, ctx.signal)

    if (!includeScreenshot) return JSON.stringify(observation, null, 2)

    const capture = await captureDisplay(
      observation,
      optionalString(args.display_id),
      observation.frameId,
      ctx.signal
    )
    return formatImageResult(capture, {
      observation,
      screenshot: screenshotMetadata(capture)
    })
  }
}

export const desktopActionTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: DESKTOP_ACTION_TOOL_NAME,
      description:
        'Control the Windows desktop through the Terminator adapter. Prefer target_ref from desktop_observe over coordinates. Coordinate actions use screenshot pixels when frame_id is supplied; without it x/y are physical desktop coordinates. This tool can click, type, press keys, scroll, drag, focus, invoke, and set controls.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'click', 'double_click', 'right_click', 'move', 'type', 'key', 'scroll', 'drag',
              'focus', 'invoke', 'set_value', 'select_option', 'set_toggled'
            ]
          },
          target_ref: { type: 'string', description: 'Preferred target reference returned by desktop_observe.' },
          process: { type: 'string', description: 'Process name required with selector.' },
          selector: { type: 'string', description: 'Raw Terminator selector; use only when target_ref is unavailable.' },
          frame_id: { type: 'string', description: 'Screenshot frame id used to translate x/y and end_x/end_y.' },
          x: { type: 'number', description: 'Target x coordinate.' },
          y: { type: 'number', description: 'Target y coordinate.' },
          end_x: { type: 'number', description: 'Drag destination x coordinate.' },
          end_y: { type: 'number', description: 'Drag destination y coordinate.' },
          text: { type: 'string', description: 'Text/value/option for type, set_value, or select_option.' },
          key: { type: 'string', description: 'Key or key chord for key, for example CTRL+S.' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number', description: 'Scroll amount. Default 3.' },
          clear_before_typing: { type: 'boolean' },
          toggled: { type: 'boolean' },
          timeout_ms: { type: 'number', description: 'Element lookup timeout, 250-30000ms.' },
          after: {
            type: 'string',
            enum: ['none', 'screenshot', 'observe'],
            description: 'Evidence returned after the action. Default screenshot; observe also refreshes semantic state.'
          },
          display_id: { type: 'string', description: 'Display to capture after the action.' }
        },
        required: ['action']
      }
    }
  },
  permission: 'dangerous',
  async execute(args, ctx) {
    const adapter = await getDesktopAdapter()
    const request: DesktopActionRequest = {
      action: args.action as DesktopActionName,
      targetRef: optionalString(args.target_ref),
      process: optionalString(args.process),
      selector: optionalString(args.selector),
      x: optionalNumber(args.x),
      y: optionalNumber(args.y),
      endX: optionalNumber(args.end_x),
      endY: optionalNumber(args.end_y),
      text: typeof args.text === 'string' ? args.text : undefined,
      key: optionalString(args.key),
      direction: args.direction as DesktopActionRequest['direction'],
      amount: optionalNumber(args.amount),
      clearBeforeTyping: optionalBoolean(args.clear_before_typing),
      toggled: optionalBoolean(args.toggled),
      timeoutMs: optionalNumber(args.timeout_ms)
    }
    translateScreenshotCoordinates(request, optionalString(args.frame_id))
    const result = await adapter.action(request, ctx.signal)
    const after = optionalString(args.after) || 'screenshot'
    if (after === 'none') return JSON.stringify(result, null, 2)

    let observation: DesktopObservation | undefined
    if (after === 'observe' && result.process) {
      observation = await adapter.observe({
        mode: 'window',
        process: result.process
      }, ctx.signal)
    }
    const capture = await captureDisplay(
      observation,
      optionalString(args.display_id),
      observation?.frameId,
      ctx.signal
    )
    if (after === 'observe' && !observation) {
      observation = createElectronScreenObservation(capture.frame.frameId, capture.displayId)
    }
    return formatImageResult(capture, {
      result,
      observation: after === 'observe' ? observation : undefined,
      screenshot: screenshotMetadata(capture)
    })
  }
}

async function captureDisplay(
  observation?: DesktopObservation,
  requestedDisplayId?: string,
  preferredFrameId?: string,
  signal?: AbortSignal
): Promise<CapturedDisplay> {
  throwIfAborted(signal)
  const displays = electronScreen.getAllDisplays()
  if (displays.length === 0) throw new Error('[CAPTURE_FAILED] Electron did not report any displays.')
  const display = selectDisplay(displays, observation, requestedDisplayId)
  const physicalMonitor = matchPhysicalMonitor(display, observation?.monitors || [])
  const physicalBounds = physicalMonitor?.bounds || electronPhysicalBounds(display)
  const aspect = physicalBounds.width / physicalBounds.height
  const targetWidth = Math.min(MAX_IMAGE_WIDTH, physicalBounds.width)
  const targetHeight = Math.max(1, Math.round(targetWidth / aspect))
  const sources = await abortable(desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetWidth, height: targetHeight },
    fetchWindowIcons: false
  }), signal)
  const source = sources.find(item => item.display_id === String(display.id))
    || (display.id === electronScreen.getPrimaryDisplay().id ? sources[0] : undefined)
  if (!source) throw new Error(`[CAPTURE_FAILED] No desktop capture source matched display ${display.id}.`)

  throwIfAborted(signal)
  const size = source.thumbnail.getSize()
  const frame: ScreenshotCoordinateFrame = {
    frameId: preferredFrameId || createScreenshotFrameId(),
    imageWidth: size.width,
    imageHeight: size.height,
    screenBounds: physicalBounds
  }
  rememberScreenshotFrame(frame)
  return {
    base64: source.thumbnail.toPNG().toString('base64'),
    frame,
    displayId: String(display.id),
    displayName: display.label || physicalMonitor?.name || `Display ${display.id}`,
    scaleFactor: physicalMonitor?.scaleFactor || display.scaleFactor || 1
  }
}

function createElectronScreenObservation(
  frameId = createScreenshotFrameId(),
  activeDisplayId?: string
): DesktopObservation {
  const displays = electronScreen.getAllDisplays()
  if (displays.length === 0) throw new Error('[CAPTURE_FAILED] Electron did not report any displays.')
  const primaryId = electronScreen.getPrimaryDisplay().id
  const activeDisplay = activeDisplayId
    ? displays.find(display => String(display.id) === activeDisplayId)
    : electronScreen.getDisplayNearestPoint(electronScreen.getCursorScreenPoint())

  return {
    backend: 'electron-desktop-capturer',
    platform: process.platform,
    frameId,
    monitors: displays.map(display => ({
      id: String(display.id),
      name: display.label || `Display ${display.id}`,
      isPrimary: display.id === primaryId,
      bounds: electronPhysicalBounds(display),
      scaleFactor: display.scaleFactor || 1
    })),
    activeMonitorId: activeDisplay ? String(activeDisplay.id) : String(primaryId)
  }
}

function selectDisplay(
  displays: Display[],
  observation: DesktopObservation | undefined,
  requestedDisplayId: string | undefined
): Display {
  if (requestedDisplayId) {
    const requestedMonitor = observation?.monitors.find(monitor => monitor.id === requestedDisplayId)
    const selected = displays.find(display => String(display.id) === requestedDisplayId)
      || (requestedMonitor
        ? [...displays].sort((a, b) => monitorScore(a, requestedMonitor) - monitorScore(b, requestedMonitor))[0]
        : undefined)
    if (!selected) throw new Error(`[DISPLAY_NOT_FOUND] Display "${requestedDisplayId}" was not found.`)
    return selected
  }
  const activeMonitor = observation?.monitors.find(monitor => monitor.id === observation.activeMonitorId)
  if (activeMonitor) {
    return [...displays].sort((a, b) => monitorScore(a, activeMonitor) - monitorScore(b, activeMonitor))[0]
  }
  return electronScreen.getDisplayNearestPoint(electronScreen.getCursorScreenPoint())
}

function matchPhysicalMonitor(display: Display, monitors: DesktopMonitor[]): DesktopMonitor | undefined {
  return [...monitors].sort((a, b) => monitorScore(display, a) - monitorScore(display, b))[0]
}

function monitorScore(display: Display, monitor: DesktopMonitor): number {
  const primaryDisplay = display.id === electronScreen.getPrimaryDisplay().id
  const primaryPenalty = primaryDisplay === monitor.isPrimary ? 0 : 1_000_000
  const physical = electronPhysicalBounds(display)
  const sizePenalty = Math.abs(physical.width - monitor.bounds.width) + Math.abs(physical.height - monitor.bounds.height)
  const sidePenalty = Math.abs(Math.sign(physical.x) - Math.sign(monitor.bounds.x)) * 1000
  return primaryPenalty + sizePenalty + sidePenalty
}

function electronPhysicalBounds(display: Display) {
  const scale = display.scaleFactor || 1
  return {
    x: Math.round(display.bounds.x * scale),
    y: Math.round(display.bounds.y * scale),
    width: Math.round(display.bounds.width * scale),
    height: Math.round(display.bounds.height * scale)
  }
}

function translateScreenshotCoordinates(request: DesktopActionRequest, frameId?: string): void {
  if (!frameId) return
  const frame = resolveScreenshotFrame(frameId)
  if (request.x !== undefined && request.y !== undefined) {
    const point = screenshotPointToScreen(frame, request.x, request.y)
    request.x = point.x
    request.y = point.y
  }
  if (request.endX !== undefined && request.endY !== undefined) {
    const point = screenshotPointToScreen(frame, request.endX, request.endY)
    request.endX = point.x
    request.endY = point.y
  }
}

function rememberScreenshotFrame(frame: ScreenshotCoordinateFrame): void {
  pruneScreenshotFrames()
  screenshotFrames.set(frame.frameId, { createdAt: Date.now(), frame })
  while (screenshotFrames.size > MAX_SCREENSHOT_FRAMES) {
    const oldest = screenshotFrames.keys().next().value as string | undefined
    if (!oldest) break
    screenshotFrames.delete(oldest)
  }
}

function resolveScreenshotFrame(frameId: string): ScreenshotCoordinateFrame {
  pruneScreenshotFrames()
  const frame = screenshotFrames.get(frameId)?.frame
  if (!frame) throw new Error(`[STALE_FRAME] Screenshot frame "${frameId}" is missing or expired. Call desktop_observe again.`)
  return frame
}

function pruneScreenshotFrames(): void {
  const cutoff = Date.now() - SCREENSHOT_FRAME_TTL_MS
  for (const [id, entry] of screenshotFrames) {
    if (entry.createdAt < cutoff) screenshotFrames.delete(id)
  }
}

function createScreenshotFrameId(): string {
  screenshotSequence += 1
  return `c${Date.now().toString(36)}_${screenshotSequence.toString(36)}`
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('[DESKTOP_ABORTED] Desktop capture was cancelled.')
  error.name = 'AbortError'
  throw error
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) return Promise.reject(desktopAbortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(desktopAbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function desktopAbortError(): Error {
  const error = new Error('[DESKTOP_ABORTED] Desktop capture was cancelled.')
  error.name = 'AbortError'
  return error
}

function screenshotMetadata(capture: CapturedDisplay) {
  return {
    frame_id: capture.frame.frameId,
    display_id: capture.displayId,
    display_name: capture.displayName,
    image_size: { width: capture.frame.imageWidth, height: capture.frame.imageHeight },
    physical_bounds: capture.frame.screenBounds,
    scale_factor: capture.scaleFactor,
    coordinates: 'Use screenshot pixel coordinates with this frame_id in desktop_action.'
  }
}

function formatImageResult(capture: CapturedDisplay, payload: Record<string, unknown>) {
  return {
    content: JSON.stringify(payload, null, 2),
    attachments: [{
      type: 'image' as const,
      mediaType: 'image/png' as const,
      base64: capture.base64,
      detail: 'auto' as const
    }]
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export const desktopTools: { name: string; handler: ToolHandler }[] = [
  { name: DESKTOP_OBSERVE_TOOL_NAME, handler: desktopObserveTool },
  { name: DESKTOP_ACTION_TOOL_NAME, handler: desktopActionTool }
]
