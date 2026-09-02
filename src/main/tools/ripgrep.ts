import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { rgPath } from '@vscode/ripgrep'

const MAX_RECORD_BYTES = 64 * 1024
const MAX_PREVIEW_CHARS = 2_000

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
}

async function runRipgrep(args: string[], cwd: string, signal?: AbortSignal): Promise<RunResult> {
  if (signal?.aborted) throw new Error('Search aborted')
  return new Promise((resolve, reject) => {
    const child = spawn(runtimeRgPath(), args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const maxCapture = 8 * 1024 * 1024

    const collect = (target: Buffer[], chunk: Buffer, current: number): number => {
      if (current >= maxCapture) return current
      const accepted = chunk.subarray(0, maxCapture - current)
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
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? -1
      })
    })
  })
}

export async function grepWithRipgrep(options: {
  workspacePath: string
  searchPath?: string
  pattern: string
  include?: string
  exclude?: string[]
  limit?: unknown
  signal?: AbortSignal
}): Promise<string> {
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
  if (result.code === 2) throw new Error(result.stderr.trim() || 'ripgrep rejected the search pattern')
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`)

  const matches: string[] = []
  for (const record of result.stdout.split(/\r?\n/)) {
    if (!record || Buffer.byteLength(record) > MAX_RECORD_BYTES) continue
    let parsed: any
    try { parsed = JSON.parse(record) } catch { continue }
    if (parsed.type !== 'match') continue
    const data = parsed.data
    const file = normalizeResultPath(options.workspacePath, cwd, data.path?.text || '')
    const line = Number(data.line_number || 0)
    const preview = String(data.lines?.text || '').replace(/\r?\n$/, '').slice(0, MAX_PREVIEW_CHARS)
    matches.push(`${file}:${line}: ${preview}${String(data.lines?.text || '').length > MAX_PREVIEW_CHARS ? '…' : ''}`)
    if (matches.length > limit) break
  }
  if (matches.length === 0) return 'No matches found'
  if (matches.length > limit) {
    matches.length = limit
    matches.push(`... (truncated at ${limit} matches; narrow the pattern or path)`)
  }
  return matches.join('\n')
}

export async function globWithRipgrep(options: {
  workspacePath: string
  searchPath?: string
  pattern: string
  exclude?: string[]
  limit?: unknown
  signal?: AbortSignal
}): Promise<string> {
  const cwd = path.resolve(options.workspacePath, options.searchPath || '.')
  const limit = positiveLimit(options.limit, 500, 2_000)
  const args = ['--no-config', '--files', '--no-require-git', `--glob=${options.pattern}`, '--glob=!**/.git/**']
  for (const exclude of options.exclude || []) args.push(`--glob=${exclusionGlob(exclude)}`)
  args.push('.')
  const result = await runRipgrep(args, cwd, options.signal)
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.code}`)

  const files = result.stdout.split(/\r?\n/).filter(Boolean)
    .map(file => normalizeResultPath(options.workspacePath, cwd, file))
    .slice(0, limit + 1)
  if (files.length === 0) return 'No files found'
  if (files.length > limit) {
    files.length = limit
    files.push(`... (truncated at ${limit} files; narrow the pattern or path)`)
  }
  return files.join('\n')
}
