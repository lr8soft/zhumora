import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { BoundedToolOutput, MAX_COMMAND_OUTPUT_LINES } from './outputLimits.ts'
import type { Readable } from 'node:stream'
import type { ToolOutputStore, ToolOutputWriter } from './toolOutputStore.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

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

interface ShellOptions {
  workspacePath: string
  command: string
  workdir?: string
  timeoutSeconds?: unknown
  mode?: ShellExecutionMode
  signal?: AbortSignal
  outputStore?: ToolOutputStore
  sessionId?: string
  onOutputRef?: (id: string) => void
}

export async function executeShellCommand(options: ShellOptions): Promise<string> {
  if (!options.command?.trim()) throw new Error('command is required')
  if (options.signal?.aborted) throw new Error('Command aborted')
  const mode = options.mode ?? 'wait'
  if (mode !== 'wait' && mode !== 'detach') throw new Error('mode must be "wait" or "detach"')
  const cwd = path.resolve(options.workspacePath, options.workdir || '.')
  if (mode === 'detach') return launchDetached(options.command, cwd, options.signal)
  const timeoutMs = resolveTimeout(options.timeoutSeconds)
  return runCommand(options, cwd, timeoutMs, new ShellOutput(options))
}

function runCommand(options: ShellOptions, cwd: string, timeoutMs: number, output: ShellOutput): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, {
      cwd,
      shell: shellPath(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let settled = false
    let finishing = false
    let timedOut = false
    let exitCode: number | null = null
    let savingDeadline: ReturnType<typeof setTimeout> | undefined
    const drains = Promise.all([output.drain(child.stdout), output.drain(child.stderr)])
    const cleanup = () => {
      clearTimeout(timeout)
      clearTimeout(savingDeadline)
      options.signal?.removeEventListener('abort', stop)
    }
    const disconnect = (discard = false) => {
      output.stop(discard)
      if (child.pid) killProcessTree(child.pid)
      child.stdout.destroy(); child.stderr.destroy(); child.unref()
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup(); disconnect(true)
      // A blocked filesystem operation must not block user cancellation.
      void output.discard().catch(() => undefined)
      reject(error)
    }
    const finish = async (code: number | null) => {
      if (settled || finishing) return
      finishing = true
      if (!timedOut) exitCode = code
      try {
        await drains
        if (settled) return
        const text = await output.finish(exitCode, timedOut ? Math.round(timeoutMs / 1000) : undefined)
        if (settled) return
        settled = true; cleanup(); resolve(text)
      } catch (error) { fail(error) }
    }
    const stop = () => fail(new Error('Command aborted'))
    const timeout = setTimeout(() => {
      if (settled) return
      timedOut = true; exitCode = null; disconnect()
      savingDeadline = setTimeout(() => fail(new Error('Command timed out while saving output; the result is incomplete')), 1000)
      savingDeadline.unref()
      void finish(null)
    }, timeoutMs)
    timeout.unref()
    options.signal?.addEventListener('abort', stop, { once: true })
    if (options.signal?.aborted) stop()
    void drains.catch(fail)
    child.once('error', fail)
    child.once('close', code => { void finish(code) })
  })
}

/** Each pipe waits for its disk append, so a verbose process cannot grow an unbounded write queue. */
class ShellOutput {
  private readonly preview = new BoundedToolOutput('Use the saved output_id with read_tool_output to inspect omitted logs.', MAX_COMMAND_OUTPUT_LINES)
  private stopped = false
  private discarded = false
  private writer?: ToolOutputWriter
  private buffered = ''
  private pending = Promise.resolve()
  private readonly options: ShellOptions
  constructor(options: ShellOptions) { this.options = options }
  stop(discard = false): void { this.stopped = true; this.discarded ||= discard }
  private append(text: string): Promise<void> {
    this.preview.append(text)
    this.pending = this.pending.then(async () => {
      if (this.discarded) return
      if (this.writer) { await this.writer.append(text); return }
      if (!this.options.outputStore || !this.options.sessionId) return
      this.buffered += text
      if (!this.preview.snapshot().truncated) return
      this.writer = await this.options.outputStore.createWriter(this.options.sessionId, this.options.signal)
      if (this.discarded) { await this.writer.discard(); return }
      await this.writer.append(this.buffered)
      this.buffered = ''
    })
    return this.pending
  }
  async drain(stream: Readable): Promise<void> {
    const decoder = new StringDecoder('utf8')
    try {
      for await (const chunk of stream) {
        const text = decoder.write(chunk as Buffer)
        await this.append(text)
      }
      const tail = decoder.end()
      if (tail) await this.append(tail)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!this.stopped || (code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ERR_STREAM_DESTROYED')) throw error
    }
  }
  async finish(code: number | null, timeoutSeconds?: number): Promise<string> {
    const snapshot = this.preview.snapshot()
    const metadata = [`[exit code: ${code ?? -1}]`, ...(timeoutSeconds ? [`[timed out after ${timeoutSeconds}s]`] : [])]
    if (snapshot.truncated && this.writer) {
      const id = await this.writer.finish()
      this.options.onOutputRef?.(id)
      metadata.push(`Full output saved. Continue with read_tool_output({"output_id":"${id}","offset":1,"limit":200}); use pattern for literal text search.`)
    } else await this.writer?.discard()
    return `${snapshot.text.trimEnd() || '(no output)'}\n${metadata.join('\n')}`
  }
  async discard(): Promise<void> { await this.writer?.discard() }
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

