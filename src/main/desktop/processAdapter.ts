import type {
  DesktopActionRequest,
  DesktopActionResult,
  DesktopAdapter,
  DesktopObservation,
  DesktopObserveRequest
} from './types'
import {
  isDesktopProcessResponse,
  type DesktopProcessRequest,
  type DesktopProcessResponse
} from './processProtocol.ts'

const DEFAULT_OBSERVE_TIMEOUT_MS = 30_000
const DEFAULT_ACTION_TIMEOUT_MS = 15_000
const MAX_ACTION_TIMEOUT_MS = 45_000
const ACTION_TIMEOUT_OVERHEAD_MS = 10_000

export interface DesktopWorkerProcess {
  readonly pid?: number
  postMessage(message: DesktopProcessRequest): void
  kill(): boolean
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: (code: number) => void): void
  onError(listener: (description: string) => void): void
}

export interface TerminatorProcessAdapterOptions {
  observeTimeoutMs?: number
  actionTimeoutMs?: (request: DesktopActionRequest) => number
  onWorkerStarted?: (pid: number | undefined) => void
  onWorkerStopped?: (reason: string) => void
}

interface WorkerGeneration {
  id: number
  process: DesktopWorkerProcess
}

interface PendingRequest<T> {
  id: number
  workerId: number
  method: DesktopProcessRequest['method']
  resolve: (value: T) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

/**
 * Main-process proxy for Terminator. The native UIA addon is loaded only by the
 * utility process supplied by spawnWorker, so a stuck native call can be killed
 * without wedging Electron's browser/main process.
 */
export class TerminatorProcessAdapter implements DesktopAdapter {
  readonly name = 'terminator-windows-process'
  readonly platform = 'win32' as const

  private worker?: WorkerGeneration
  private pending?: PendingRequest<unknown>
  private operationQueue: Promise<void> = Promise.resolve()
  private requestSequence = 0
  private workerSequence = 0
  private disposed = false
  private readonly spawnWorker: () => DesktopWorkerProcess
  private readonly options: TerminatorProcessAdapterOptions

  constructor(spawnWorker: () => DesktopWorkerProcess, options: TerminatorProcessAdapterOptions = {}) {
    this.spawnWorker = spawnWorker
    this.options = options
  }

  observe(request: DesktopObserveRequest, signal?: AbortSignal): Promise<DesktopObservation> {
    return this.exclusive(() => this.callWorker<DesktopObservation>(
      'observe',
      request,
      this.options.observeTimeoutMs ?? DEFAULT_OBSERVE_TIMEOUT_MS,
      signal
    ))
  }

  action(request: DesktopActionRequest, signal?: AbortSignal): Promise<DesktopActionResult> {
    const timeoutMs = this.options.actionTimeoutMs?.(request) ?? actionTimeout(request)
    return this.exclusive(() => this.callWorker<DesktopActionResult>('action', request, timeoutMs, signal))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const worker = this.worker
    if (worker && this.pending?.workerId === worker.id) {
      this.failRequest(new Error('[DESKTOP_DISPOSED] Desktop automation process was stopped.'), worker.id)
    } else {
      this.stopWorker('[DESKTOP_DISPOSED] Desktop automation process was stopped.')
    }
    await this.operationQueue
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private callWorker<T>(
    method: DesktopProcessRequest['method'],
    payload: DesktopObserveRequest | DesktopActionRequest,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('[DESKTOP_DISPOSED] Desktop automation is shut down.'))
    if (signal?.aborted) return Promise.reject(abortError())

    const worker = this.worker || this.startWorker()
    const id = ++this.requestSequence
    const request = { id, method, payload } as DesktopProcessRequest

    return new Promise<T>((resolve, reject) => {
      const onAbort = signal
        ? () => this.failRequest(abortError(), worker.id)
        : undefined
      const timer = setTimeout(() => {
        this.failRequest(new Error(
          `[DESKTOP_TIMEOUT] Terminator ${method} did not respond within ${timeoutMs}ms. `
          + 'The isolated process was terminated and will be recreated for the next desktop call.'
        ), worker.id)
      }, timeoutMs)

      this.pending = {
        id,
        workerId: worker.id,
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        signal,
        onAbort
      }
      signal?.addEventListener('abort', onAbort!, { once: true })
      if (signal?.aborted) {
        onAbort!()
        return
      }

      try {
        worker.process.postMessage(request)
      } catch (error) {
        this.failRequest(asError(error, '[DESKTOP_PROCESS_SEND_FAILED]'), worker.id)
      }
    })
  }

  private startWorker(): WorkerGeneration {
    let child: DesktopWorkerProcess
    try {
      child = this.spawnWorker()
    } catch (error) {
      throw asError(error, '[DESKTOP_PROCESS_START_FAILED]')
    }

    const worker: WorkerGeneration = { id: ++this.workerSequence, process: child }
    this.worker = worker
    child.onMessage(message => this.handleMessage(worker.id, message))
    child.onExit(code => this.handleWorkerExit(worker.id, `exited with code ${code}`))
    child.onError(description => this.handleWorkerExit(worker.id, `failed: ${description}`))
    this.options.onWorkerStarted?.(child.pid)
    return worker
  }

  private handleMessage(workerId: number, message: unknown): void {
    if (!isDesktopProcessResponse(message)) return
    const pending = this.pending
    if (!pending || pending.workerId !== workerId || pending.id !== message.id) return
    this.clearPending(pending)

    if (message.ok) {
      pending.resolve(message.value)
      return
    }
    pending.reject(deserializeError(message))
  }

  private handleWorkerExit(workerId: number, reason: string): void {
    if (this.worker?.id !== workerId) return
    this.worker = undefined
    this.options.onWorkerStopped?.(reason)
    const pending = this.pending
    if (!pending || pending.workerId !== workerId) return
    this.clearPending(pending)
    pending.reject(new Error(
      `[DESKTOP_PROCESS_EXITED] Terminator process ${reason}. It will be recreated for the next desktop call.`
    ))
  }

  private failRequest(error: Error, workerId: number): void {
    const pending = this.pending
    if (!pending || pending.workerId !== workerId) return
    this.clearPending(pending)
    this.stopWorker(error.message, workerId)
    pending.reject(error)
  }

  private clearPending(pending: PendingRequest<unknown>): void {
    clearTimeout(pending.timer)
    if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort)
    if (this.pending === pending) this.pending = undefined
  }

  private stopWorker(reason: string, expectedWorkerId?: number): void {
    const worker = this.worker
    if (!worker || (expectedWorkerId !== undefined && worker.id !== expectedWorkerId)) return
    this.worker = undefined
    this.options.onWorkerStopped?.(reason)
    try {
      worker.process.kill()
    } catch {
      // The process may have already exited between the timeout and kill call.
    }
  }
}

function actionTimeout(request: DesktopActionRequest): number {
  const requested = request.timeoutMs ?? 0
  return Math.min(
    MAX_ACTION_TIMEOUT_MS,
    Math.max(DEFAULT_ACTION_TIMEOUT_MS, requested + ACTION_TIMEOUT_OVERHEAD_MS)
  )
}

function abortError(): Error {
  const error = new Error('[DESKTOP_ABORTED] Desktop automation was cancelled. The isolated process was terminated.')
  error.name = 'AbortError'
  return error
}

function asError(value: unknown, prefix: string): Error {
  if (value instanceof Error) {
    if (!value.message.startsWith('[')) value.message = `${prefix} ${value.message}`
    return value
  }
  return new Error(`${prefix} ${String(value)}`)
}

function deserializeError(response: Extract<DesktopProcessResponse, { ok: false }>): Error {
  const error = new Error(response.error.message)
  error.name = response.error.name || 'Error'
  if (response.error.stack) error.stack = response.error.stack
  return error
}
