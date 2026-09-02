import { spawn } from 'node:child_process'
import * as path from 'node:path'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 1024 * 1024

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
  signal?: AbortSignal
}): Promise<string> {
  if (!options.command?.trim()) throw new Error('command is required')
  if (options.signal?.aborted) throw new Error('Command aborted')
  const cwd = path.resolve(options.workspacePath, options.workdir || '.')
  const seconds = typeof options.timeoutSeconds === 'number' ? options.timeoutSeconds : Number(options.timeoutSeconds)
  const timeoutMs = Number.isFinite(seconds)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(seconds * 1_000)))
    : DEFAULT_TIMEOUT_MS

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
    let timedOut = false
    let aborted = false

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

    const stop = () => {
      aborted = true
      if (child.pid) killProcessTree(child.pid)
    }
    options.signal?.addEventListener('abort', stop, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      if (child.pid) killProcessTree(child.pid)
    }, timeoutMs)
    timeout.unref()

    child.once('error', error => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', stop)
      reject(error)
    })
    child.once('close', code => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', stop)
      if (aborted || options.signal?.aborted) return reject(new Error('Command aborted'))
      const output = Buffer.concat(chunks).toString('utf8').trimEnd()
      const metadata = [
        `[exit code: ${code ?? -1}]`,
        ...(timedOut ? [`[timed out after ${Math.round(timeoutMs / 1000)}s]`] : []),
        ...(truncated ? [`[output truncated at ${MAX_OUTPUT_BYTES} bytes]`] : [])
      ]
      resolve(`${output || '(no output)'}\n${metadata.join('\n')}`)
    })
  })
}

