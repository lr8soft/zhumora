import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { limitToolOutput } from './outputLimits.ts'
import { recoverableToolOutput } from './recoverableOutput.ts'
import type { ToolExecutionResult } from '../../shared/types.ts'
import type { ToolContext } from './registry.ts'

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const CAPTURE_LIMIT_NOTICE = '[Search capture limit reached (8 MiB); results are incomplete. Narrow the pattern or path and search again.]'

function runtimeRgPath(): string {
  return rgPath.includes('app.asar') ? rgPath.replace('app.asar', 'app.asar.unpacked') : rgPath
}

function normalizeResultPath(workspacePath: string, cwd: string, resultPath: string): string {
  const absolute = path.isAbsolute(resultPath) ? resultPath : path.resolve(cwd, resultPath)
  const relative = path.relative(workspacePath, absolute)
  return (relative && !relative.startsWith('..') ? relative : absolute).replaceAll('\\', '/')
}

function exclusionGlob(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
  return /[*?[{\/]/.test(normalized) ? `!${normalized}` : `!**/${normalized}/**`
}

function positiveLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(1, Math.floor(parsed)))
}

interface RunResult {
  stdout: string
  stderr: string
  code: number
  captureLimited: boolean
}

async function runRipgrep(args: string[], cwd: string, signal?: AbortSignal): Promise<RunResult> {
  if (signal?.aborted) throw new Error('Search aborted')
  return new Promise((resolve, reject) => {
    const child = spawn(runtimeRgPath(), args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let captureLimited = false

    const collect = (target: Buffer[], chunk: Buffer, current: number): number => {
      if (current + chunk.length > MAX_CAPTURE_BYTES) captureLimited = true
      if (current >= MAX_CAPTURE_BYTES) return current
      const accepted = chunk.subarray(0, MAX_CAPTURE_BYTES - current)
      target.push(accepted)
      return current + accepted.length
    }
    child.stdout.on('data', (chunk: Buffer) => { stdoutBytes = collect(stdout, chunk, stdoutBytes) })
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes = collect(stderr, chunk, stderrBytes) })

    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', reject)
    child.once('close', code => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(new Error('Search aborted'))
      resolve({
        // An exhausted capture may end halfway through a JSON record or filename.
        stdout: completeCapturedLines(Buffer.concat(stdout).toString('utf8'), captureLimited),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? -1,
        captureLimited
      })
    })
  })
}

function completeCapturedLines(text: string, limited: boolean): string {
  return limited ? text.slice(0, text.lastIndexOf('\n') + 1) : text
}

interface SearchOptions {
  workspacePath: string
  searchPath?: string
  pattern: string
  include?: string
  exclude?: string[]
  limit?: unknown
  signal?: AbortSignal
  context?: ToolContext
}

async function searchOutput(
  lines: string[], limit: number, kind: 'matches' | 'files', options: SearchOptions, captureLimited: boolean
): Promise<string | ToolExecutionResult> {
  const hint = `Narrow the pattern/path or use read_tool_output to inspect omitted ${kind}.`
  const full = [...lines, ...(captureLimited ? [CAPTURE_LIMIT_NOTICE] : [])].join('\n') || `No ${kind} found`
  const preview = [...lines.slice(0, limit), ...(lines.length > limit ? [`... (truncated at ${limit} ${kind}; ${hint})`] : []),
    ...(captureLimited ? [CAPTURE_LIMIT_NOTICE] : [])].join('\n') || `No ${kind} found`
  if (!options.context) return limitToolOutput(preview, hint)
  const output = await recoverableToolOutput(full, options.context, hint, undefined, preview)
  return captureLimited ? { ...output, isError: true } : output
}

export function grepWithRipgrep(options: SearchOptions & { context: ToolContext }): Promise<ToolExecutionResult>
export function grepWithRipgrep(options: SearchOptions): Promise<string>
export async function grepWithRipgrep(options: SearchOptions): Promise<string | ToolExecutionResult> {
  const target = path.resolve(options.workspacePath, options.searchPath || '.')
  const cwd = options.workspacePath
  const relativeTarget = path.relative(cwd, target)
  // Passing an absolute workspace root makes ripgrep treat it as an explicit path and can
  // bypass ignore discovery. Keep in-workspace targets relative, as OpenCode does.
  const targetArgument = !relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget)
    ? (relativeTarget || '.')
    : target
  const limit = positiveLimit(options.limit, 200, 1_000)
  const args = ['--no-config', '--json', '--hidden', '--no-messages', '--no-require-git', '--glob=!**/.git/**']
  if (options.include) args.push(`--glob=${options.include}`)
  for (const exclude of options.exclude || []) args.push(`--glob=${exclusionGlob(exclude)}`)
  args.push('--', options.pattern, targetArgument)

  const result = await runRipgrep(args, cwd, options.signal)
  if (result.code !== 0 && result.code !== 1) {
    if (options.context) return { ...await recoverableToolOutput(result.stderr.trim() || `ripgrep exited with code ${result.code}`, options.context, 'Simplify the search pattern and path.'), isError: true }
    throw new Error(limitToolOutput(result.stderr.trim() || `ripgrep exited with code ${result.code}`, 'Simplify the search pattern and path.'))
  }

  const matches: string[] = []
  for (const record of result.stdout.split(/\r?\n/)) {
    if (!record) continue
    let parsed: any
    try { parsed = JSON.parse(record) } catch { continue }
    if (parsed.type !== 'match') continue
    const data = parsed.data
    const file = normalizeResultPath(options.workspacePath, cwd, data.path?.text || '')
    const line = Number(data.line_number || 0)
    const text = String(data.lines?.text || '').replace(/\r?\n$/, '')
    matches.push(`${file}:${line}: ${text}`)
  }
  return searchOutput(matches, limit, 'matches', options, result.captureLimited)
}

export function globWithRipgrep(options: SearchOptions & { context: ToolContext }): Promise<ToolExecutionResult>
export function globWithRipgrep(options: SearchOptions): Promise<string>
export async function globWithRipgrep(options: SearchOptions): Promise<string | ToolExecutionResult> {
  const cwd = path.resolve(options.workspacePath, options.searchPath || '.')
  const limit = positiveLimit(options.limit, 500, 2_000)
  const args = ['--no-config', '--files', '--no-require-git', `--glob=${options.pattern}`, '--glob=!**/.git/**']
  for (const exclude of options.exclude || []) args.push(`--glob=${exclusionGlob(exclude)}`)
  args.push('.')
  const result = await runRipgrep(args, cwd, options.signal)
  if (result.code !== 0 && result.code !== 1) {
    if (options.context) return { ...await recoverableToolOutput(result.stderr.trim() || `ripgrep exited with code ${result.code}`, options.context, 'Simplify the glob pattern and path.'), isError: true }
    throw new Error(limitToolOutput(result.stderr.trim() || `ripgrep exited with code ${result.code}`, 'Simplify the glob pattern and path.'))
  }

  const files = result.stdout.split(/\r?\n/).filter(Boolean)
    .map(file => normalizeResultPath(options.workspacePath, cwd, file))
  return searchOutput(files, limit, 'files', options, result.captureLimited)
}
