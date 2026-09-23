import { utilityProcess, type UtilityProcess } from 'electron'
import * as path from 'node:path'
import { log } from '../llm/logger'
import {
  TerminatorProcessAdapter,
  type DesktopWorkerProcess
} from './processAdapter'
import type {
  DesktopActionRequest,
  DesktopActionResult,
  DesktopAdapter,
  DesktopObservation,
  DesktopObserveRequest
} from './types'

let adapterPromise: Promise<DesktopAdapter> | null = null

export function getDesktopAdapter(): Promise<DesktopAdapter> {
  if (!adapterPromise) adapterPromise = createDesktopAdapter()
  return adapterPromise
}

export async function disposeDesktopAdapter(): Promise<void> {
  const current = adapterPromise
  adapterPromise = null
  if (!current) return
  const adapter = await current
  await adapter.dispose()
}

export const supportsDesktopAutomation = (): boolean => process.platform === 'win32'

async function createDesktopAdapter(): Promise<DesktopAdapter> {
  switch (process.platform) {
    case 'win32':
      return new TerminatorProcessAdapter(spawnTerminatorWorker, {
        onWorkerStarted: pid => log('info', `Desktop automation process started${pid ? ` (pid ${pid})` : ''}`),
        onWorkerStopped: reason => log('warn', `Desktop automation process stopped: ${reason}`)
      })
    case 'darwin':
      throw new Error('[UNSUPPORTED_PLATFORM] macOS desktop control adapter is not implemented yet.')
    case 'linux':
      return new LinuxScreenshotAdapter()
    default:
      throw new Error(`[UNSUPPORTED_PLATFORM] Desktop control is not supported on ${process.platform}.`)
  }
}

/**
 * Linux 没有 Terminator（UIA 无障碍树 + 输入注入是 Windows 专有），桌面控制
 * 只保留 Electron 截屏观察；动作类工具在 composition 层按平台不注册。
 */
export class LinuxScreenshotAdapter implements DesktopAdapter {
  readonly name = 'linux-electron-screenshot'
  readonly platform = 'linux' as const

  observe(request: DesktopObserveRequest, signal?: AbortSignal): Promise<DesktopObservation> {
    void request
    void signal
    return Promise.resolve({
      backend: this.name,
      platform: this.platform,
      frameId: '',
      monitors: [],
      message:
        'Linux: UI access (window tree) and input injection (desktop_key/desktop_type/desktop_action) '
        + 'are not available. Use mode=screen (Electron screenshot) for visual observation.'
    })
  }

  action(_request: DesktopActionRequest, _signal?: AbortSignal): Promise<DesktopActionResult> {
    return Promise.reject(new Error(
      '[UNSUPPORTED_PLATFORM] Desktop input is only available on Windows. '
      + 'Linux keeps Electron screenshot observation only.'
    ))
  }

  async dispose(): Promise<void> {}
}

function spawnTerminatorWorker(): DesktopWorkerProcess {
  const child = utilityProcess.fork(path.join(__dirname, 'terminatorWorker.js'), [], {
    serviceName: 'Zhumora Desktop Automation',
    stdio: 'pipe'
  })
  forwardOutput(child)

  return {
    get pid() { return child.pid },
    postMessage(message) { child.postMessage(message) },
    kill() { return child.kill() },
    onMessage(listener) { child.on('message', listener) },
    onExit(listener) { child.on('exit', listener) },
    onError(listener) {
      child.on('error', (type, location) => listener(`${type}${location ? ` at ${location}` : ''}`))
    }
  }
}

function forwardOutput(child: UtilityProcess): void {
  child.stdout?.on('data', chunk => {
    const message = String(chunk).trim()
    if (message) log('info', `[desktop-process] ${message}`)
  })
  child.stderr?.on('data', chunk => {
    const message = String(chunk).trim()
    if (message) log('warn', `[desktop-process] ${message}`)
  })
}
