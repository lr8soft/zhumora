export type DesktopObserveMode = 'applications' | 'screen' | 'window'

export interface DesktopBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopMonitor {
  id: string
  name: string
  isPrimary: boolean
  bounds: DesktopBounds
  scaleFactor: number
}

export interface DesktopApplication {
  name: string
  process: string
  pid: number
}

export interface DesktopTarget {
  ref: string
  role: string
  name: string
  bounds: DesktopBounds
}

export interface DesktopObserveRequest {
  mode: DesktopObserveMode
  process?: string
  title?: string
  maxDepth?: number
  maxElements?: number
}

export interface DesktopObservation {
  backend: string
  platform: NodeJS.Platform
  frameId: string
  monitors: DesktopMonitor[]
  activeMonitorId?: string
  activeApplication?: DesktopApplication
  applications?: DesktopApplication[]
  process?: string
  title?: string
  tree?: string
  targets?: DesktopTarget[]
  targetCount?: number
}

export type DesktopActionName =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'move'
  | 'type'
  | 'key'
  | 'scroll'
  | 'drag'
  | 'focus'
  | 'invoke'
  | 'set_value'
  | 'select_option'
  | 'set_toggled'

export interface DesktopActionRequest {
  action: DesktopActionName
  targetRef?: string
  process?: string
  selector?: string
  x?: number
  y?: number
  endX?: number
  endY?: number
  text?: string
  key?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  clearBeforeTyping?: boolean
  toggled?: boolean
  timeoutMs?: number
}

export interface DesktopActionResult {
  backend: string
  success: boolean
  action: DesktopActionName
  message: string
  process?: string
  targetRef?: string
  details?: unknown
}

export interface DesktopAdapter {
  readonly name: string
  readonly platform: NodeJS.Platform
  observe(request: DesktopObserveRequest, signal?: AbortSignal): Promise<DesktopObservation>
  action(request: DesktopActionRequest, signal?: AbortSignal): Promise<DesktopActionResult>
  dispose(): Promise<void>
}
