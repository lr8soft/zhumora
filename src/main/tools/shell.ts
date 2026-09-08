import { spawn } from 'node:child_process'
import * as path from 'node:path'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 1024 * 1024

export type ShellExecutionMode = 'wait' | 'detach'

function shellPath(): string {
  return process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
    return
  }
  try { process.kill(-pid, 'SIGTERM') } catch { /* process may already have exited */ }
  const timer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* process may already have exited */ }
  }, 3_000)
  timer.unref()
}

export async function executeShellCommand(options: {
  workspacePath: string
  command: string
  workdir?: string
  timeoutSeconds?: unknown
  mode?: ShellExecutionMode
  signal?: AbortSignal
}): Promise<string> {
  if (!options.command?.trim()) throw new Error('command is required')
  if (options.signal?.aborted) throw new Error('Command aborted')
  const mode = options.mode ?? 'wait'
  if (mode !== 'wait' && mode !== 'detach') throw new Error('mode must be "wait" or "detach"')
  const cwd = path.resolve(options.workspacePath, options.workdir || '.')
  if (mode === 'detach') return launchDetached(options.command, cwd, options.signal)
  const timeoutMs = resolveTimeout(options.timeoutSeconds)

  return new Promise((resolve, reject) => {
    const child = spawn(options.command, {
      cwd,
      shell: shellPath(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks: Buffer[] = []
    let captured = 0
    let truncated = false
    let settled = false

    const collect = (chunk: Buffer) => {
      if (captured >= MAX_OUTPUT_BYTES) {
        truncated = true
        return
      }
      const accepted = chunk.subarray(0, MAX_OUTPUT_BYTES - captured)
      chunks.push(accepted)
      captured += accepted.length
      if (accepted.length < chunk.length) truncated = true
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const cleanup = () => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', stop)
    }
    const disconnect = () => {
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
    }
    const output = (code: number | null, timedOut = false) => {
      const text = Buffer.concat(chunks).toString('utf8').trimEnd()
      const metadata = [
        `[exit code: ${code ?? -1}]`,
        ...(timedOut ? [`[timed out after ${Math.round(timeoutMs / 1000)}s]`] : []),
        ...(truncated ? [`[output truncated at ${MAX_OUTPUT_BYTES} bytes]`] : [])
      ]
      return `${text || '(no output)'}\n${metadata.join('\n')}`
    }
    const stop = () => {
      if (settled) return
      settled = true
      cleanup()
      if (child.pid) killProcessTree(child.pid)
      disconnect()
      reject(new Error('Command aborted'))
    }
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      if (child.pid) killProcessTree(child.pid)
      disconnect()
      resolve(output(null, true))
    }, timeoutMs)
    timeout.unref()
    options.signal?.addEventListener('abort', stop, { once: true })
    if (options.signal?.aborted) stop()

    child.once('error', error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      cleanup()
      resolve(output(code))
    })
  })
}

function resolveTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('timeout must be a finite number of seconds')
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(value * 1_000)))
}

function launchDetached(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: shellPath(),
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    })
    let settled = false
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const abort = () => {
      if (settled) return
      settled = true
      cleanup()
      if (child.pid) killProcessTree(child.pid)
      child.unref()
      reject(new Error('Command aborted'))
    }
    child.once('error', error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.once('spawn', () => {
      if (settled) {
        if (child.pid) killProcessTree(child.pid)
        child.unref()
        return
      }
      settled = true
      cleanup()
      child.unref()
      resolve(`(started in detached mode)\n[launcher pid: ${child.pid ?? -1}]`)
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

