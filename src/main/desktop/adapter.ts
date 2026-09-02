import { utilityProcess, type UtilityProcess } from 'electron'
import * as path from 'node:path'
import { log } from '../llm/logger'
import {
  TerminatorProcessAdapter,
  type DesktopWorkerProcess
} from './processAdapter'
import type { DesktopAdapter } from './types'

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
      throw new Error('[UNSUPPORTED_PLATFORM] Linux desktop control adapter is not implemented yet.')
    default:
      throw new Error(`[UNSUPPORTED_PLATFORM] Desktop control is not supported on ${process.platform}.`)
  }
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
