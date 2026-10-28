import { createReadStream, promises as fs } from 'node:fs'
import * as path from 'node:path'
import { limitToolOutput, MAX_TOOL_OUTPUT_CHARS, utf16Prefix } from './outputLimits.ts'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const MAX_READ_LINES = 2_000
const MAX_READ_BYTES = 50 * 1024
const MAX_LINE_CHARS = 2_000

const BINARY_EXTENSIONS = new Set([
  '.7z', '.a', '.avi', '.bin', '.bmp', '.class', '.db', '.dll', '.dylib', '.eot', '.exe',
  '.flac', '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.lockb', '.mov', '.mp3', '.mp4',
  '.o', '.otf', '.pdf', '.png', '.pptx', '.pyc', '.so', '.sqlite', '.tar', '.ttf', '.wav',
  '.webm', '.webp', '.woff', '.woff2', '.xlsx', '.xz', '.zip', '.docx'
])

export function resolveToolPath(workspacePath: string, requestedPath: string): string {
  if (!requestedPath?.trim()) throw new Error('A file path is required')
  return path.resolve(workspacePath, requestedPath)
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)
}

function detectBinary(sample: Buffer, filePath: string): boolean {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true
  if (sample.includes(0)) return true
  if (sample.length === 0) return false

  let suspicious = 0
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++
  }
  return suspicious / sample.length > 0.3
}

function asPositiveInteger(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(1, Math.floor(parsed)))
}

async function readSample(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r')
  try {
    const sample = Buffer.allocUnsafe(8 * 1024)
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
    return sample.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Only one line window is retained, even when a minified file has a multi-megabyte line. */
class TextReadPage {
  readonly output: string[] = []
  lineNumber = 1
  hasMore = false
  private outputBytes = 0
  private line = ''
  private lineChars = 0
  private shortened = false
  private offset: number
  private limit: number
  private charOffset: number

  constructor(offset: number, limit: number, charOffset: number) {
    this.offset = offset; this.limit = limit; this.charOffset = charOffset
  }

  append(piece: string): void {
    if (this.lineNumber < this.offset || this.shortened) { this.lineChars += piece.length; return }
    let start = Math.min(piece.length, Math.max(0, this.charOffset - this.lineChars))
    // Normalize a manually supplied offset inside a surrogate pair to its beginning.
    if (start > 0 && start < piece.length && /[\uDC00-\uDFFF]/.test(piece[start]) && /[\uD800-\uDBFF]/.test(piece[start - 1])) {
      start--; this.charOffset--
    }
    this.lineChars += piece.length
    const remaining = piece.slice(start)
    const kept = utf16Prefix(remaining, MAX_LINE_CHARS - this.line.length)
    this.line += kept
    this.shortened ||= kept.length < remaining.length
  }

  consumeLine(): boolean {
    if (this.lineNumber >= this.offset) {
      if (this.output.length >= this.limit) { this.hasMore = true; return false }
      if (this.charOffset > this.lineChars) throw new Error(`char_offset ${this.charOffset} is beyond line ${this.lineNumber} (${this.lineChars} characters)`)
      const display = this.line.endsWith('\r') ? this.line.slice(0, -1) : this.line
      const next = this.charOffset + display.length
      const notice = this.shortened ? `… [line truncated; continue with offset=${this.lineNumber}, char_offset=${next}, limit=1]` : ''
      const rendered = `${String(this.lineNumber).padStart(6)}: ${display}${notice}`
      const bytes = Buffer.byteLength(rendered + '\n')
      if (this.output.length > 0 && this.outputBytes + bytes > MAX_READ_BYTES) { this.hasMore = true; return false }
      this.output.push(rendered); this.outputBytes += bytes
    }
    this.lineNumber++; this.line = ''; this.lineChars = 0; this.shortened = false
    if (this.lineNumber > this.offset) this.charOffset = 0
    return true
  }

  finish(hasContent: boolean): string {
    if (!this.hasMore && this.lineChars > 0) this.consumeLine()
    if (!this.output.length && hasContent && this.lineNumber <= this.offset) {
      throw new Error(`Offset ${this.offset} is beyond the end of the file (${Math.max(0, this.lineNumber - 1)} lines)`)
    }
    if (this.hasMore) this.output.push(`... (output limited to ${this.limit} lines / 50KB; continue with offset=${this.offset + this.output.length})`)
    return this.output.join('\n') || '(empty file)'
  }
}

async function readTextPage(filePath: string, size: number, page: TextReadPage, signal?: AbortSignal): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const stream = createReadStream(filePath)
  try {
    outer: for await (const rawChunk of stream) {
      if (signal?.aborted) throw new Error('Read aborted')
      const pieces = decoder.decode(rawChunk as Buffer, { stream: true }).split('\n')
      for (let index = 0; index < pieces.length; index++) {
        page.append(pieces[index])
        if (index < pieces.length - 1 && !page.consumeLine()) break outer
      }
    }
    if (!page.hasMore) page.append(decoder.decode())
    return page.finish(size > 0)
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`File is not valid UTF-8 text: ${filePath}`)
    throw error
  } finally { stream.destroy() }
}

export async function readPath(
  workspacePath: string, requestedPath: string, offsetValue?: unknown, limitValue?: unknown,
  signal?: AbortSignal, charOffsetValue?: unknown
): Promise<string> {
  const resolved = resolveToolPath(workspacePath, requestedPath)
  const stat = await fs.stat(resolved)
  const offset = asPositiveInteger(offsetValue, 1)
  const limit = asPositiveInteger(limitValue, MAX_READ_LINES, MAX_READ_LINES)
  const charOffset = charOffsetValue === undefined ? 0 : charOffsetValue
  if (typeof charOffset !== 'number' || !Number.isSafeInteger(charOffset) || charOffset < 0) throw new Error('char_offset must be a non-negative integer')
  if (signal?.aborted) throw new Error('Read aborted')
  if (stat.isDirectory()) {
    if (charOffset) throw new Error('char_offset is only supported for text files')
    return readDirectory(resolved, offset, limit)
  }
  if (!stat.isFile()) throw new Error(`Unsupported filesystem entry: ${resolved}`)
  if (detectBinary(await readSample(resolved), resolved)) throw new Error(`Cannot read binary file as text: ${resolved}`)
  return readTextPage(resolved, stat.size, new TextReadPage(offset, limit, charOffset), signal)
}

async function readDirectory(directoryPath: string, offset: number, limit: number): Promise<string> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true })
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  const start = offset - 1
  if (start >= entries.length && entries.length > 0) {
    throw new Error(`Offset ${offset} is beyond the directory listing (${entries.length} entries)`)
  }
  const result: string[] = []; let chars = 0
  for (const entry of entries.slice(start, start + limit)) {
    const line = `${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'l'} ${entry.name}${entry.isDirectory() ? '/' : ''}`
    if (result.length && chars + line.length + 1 > MAX_TOOL_OUTPUT_CHARS - 256) break
    result.push(line); chars += line.length + 1
  }
  if (start + result.length < entries.length) {
    result.push(`... (${entries.length - start - result.length} more entries; continue with offset=${start + result.length + 1})`)
  }
  return result.join('\n') || '(empty directory)'
}

async function readUtf8Buffer(filePath: string): Promise<{ raw: Buffer; text: string; bom: boolean }> {
  const raw = await fs.readFile(filePath)
  if (detectBinary(raw.subarray(0, 8 * 1024), filePath)) throw new Error(`Cannot edit binary file: ${filePath}`)
  const bom = hasUtf8Bom(raw)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bom ? raw.subarray(3) : raw)
    return { raw, text, bom }
  } catch {
    throw new Error(`File is not valid UTF-8 text: ${filePath}`)
  }
}

function normalizeLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function encodeUtf8(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, 'utf8')
  return bom ? Buffer.concat([UTF8_BOM, body]) : body
}

export async function writeFilePreservingBom(workspacePath: string, requestedPath: string, content: string): Promise<string> {
  const resolved = resolveToolPath(workspacePath, requestedPath)
  let bom = false
  let existed = false
  try {
    const sample = await readSample(resolved)
    existed = true
    bom = hasUtf8Bom(sample)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, encodeUtf8(content, bom))
  return `${existed ? 'Wrote' : 'Created'} file: ${resolved}`
}

function previewReplacement(oldText: string, newText: string): string {
  const oldLines = normalizeLf(oldText).split('\n').slice(0, 4).map(line => `- ${line}`)
  const newLines = normalizeLf(newText).split('\n').slice(0, 4).map(line => `+ ${line}`)
  const clipped = normalizeLf(oldText).split('\n').length > 4 || normalizeLf(newText).split('\n').length > 4
  return limitToolOutput([...oldLines, ...newLines, ...(clipped ? ['  ...'] : [])].join('\n'), 'Read the edited file with offset/limit to inspect the changes.')
}

export async function editFileExact(
  workspacePath: string,
  requestedPath: string,
  oldString: string,
  newString: string,
  replaceAll = false
): Promise<string> {
  const resolved = resolveToolPath(workspacePath, requestedPath)
  if (!oldString) throw new Error('oldString must not be empty')
  if (oldString === newString) throw new Error('oldString and newString are identical')

  const before = await readUtf8Buffer(resolved)
  const eol = before.text.includes('\r\n') ? '\r\n' : '\n'
  const normalized = normalizeLf(before.text)
  const normalizedOld = normalizeLf(oldString)
  const normalizedNew = normalizeLf(newString)
  const count = normalized.split(normalizedOld).length - 1
  if (count === 0) throw new Error('oldString was not found. Re-read the file and copy the exact text, including indentation.')
  if (count > 1 && !replaceAll) {
    throw new Error(`${count} matches found. Include more surrounding context or set replaceAll=true.`)
  }

  const edited = replaceAll
    ? normalized.split(normalizedOld).join(normalizedNew)
    : normalized.replace(normalizedOld, () => normalizedNew)
  const output = edited.split('\n').join(eol)

  // Match OpenCode's stale-write protection: never overwrite a file changed after it was read.
  const current = await fs.readFile(resolved)
  if (!current.equals(before.raw)) throw new Error('File changed after it was read; re-read it before editing')
  await fs.writeFile(resolved, encodeUtf8(output, before.bom))

  return `Edited file: ${resolved} (${replaceAll ? count : 1} replacement${replaceAll && count !== 1 ? 's' : ''})\n${previewReplacement(oldString, newString)}`
}
