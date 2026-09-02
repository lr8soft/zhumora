import { createReadStream, promises as fs } from 'node:fs'
import * as path from 'node:path'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const MAX_READ_LINES = 2_000
const MAX_READ_BYTES = 50 * 1024
const MAX_LINE_CHARS = 2_000

const BINARY_EXTENSIONS = new Set([
  '.7z', '.a', '.avi', '.bin', '.bmp', '.class', '.db', '.dll', '.dylib', '.eot', '.exe',
  '.flac', '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.lockb', '.mov', '.mp3', '.mp4',
  '.o', '.otf', '.pdf', '.png', '.pyc', '.so', '.sqlite', '.tar', '.ttf', '.wav', '.webm',
  '.webp', '.woff', '.woff2', '.xz', '.zip'
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

export async function readPath(
  workspacePath: string,
  requestedPath: string,
  offsetValue?: unknown,
  limitValue?: unknown,
  signal?: AbortSignal
): Promise<string> {
  const resolved = resolveToolPath(workspacePath, requestedPath)
  const stat = await fs.stat(resolved)
  const offset = asPositiveInteger(offsetValue, 1)
  const limit = asPositiveInteger(limitValue, MAX_READ_LINES, MAX_READ_LINES)

  if (stat.isDirectory()) return readDirectory(resolved, offset, limit)
  if (!stat.isFile()) throw new Error(`Unsupported filesystem entry: ${resolved}`)

  const sample = await readSample(resolved)
  if (detectBinary(sample, resolved)) {
    throw new Error(`Cannot read binary file as text: ${resolved}`)
  }

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const stream = createReadStream(resolved)
  const output: string[] = []
  let outputBytes = 0
  let lineNumber = 1
  let currentLine = ''
  let lineWasTruncated = false
  let hasMore = false
  let reachedEof = false

  const consumeLine = (): boolean => {
    const displayLine = currentLine.endsWith('\r') ? currentLine.slice(0, -1) : currentLine
    if (lineNumber >= offset) {
      if (output.length >= limit) {
        hasMore = true
        return false
      }
      const suffix = lineWasTruncated ? '…' : ''
      const rendered = `${String(lineNumber).padStart(6)}: ${displayLine}${suffix}`
      const renderedBytes = Buffer.byteLength(rendered + '\n')
      if (output.length > 0 && outputBytes + renderedBytes > MAX_READ_BYTES) {
        hasMore = true
        return false
      }
      output.push(rendered)
      outputBytes += renderedBytes
    }
    lineNumber++
    currentLine = ''
    lineWasTruncated = false
    return true
  }

  try {
    outer: for await (const rawChunk of stream) {
      if (signal?.aborted) throw new Error('Read aborted')
      const text = decoder.decode(rawChunk as Buffer, { stream: true })
      const pieces = text.split('\n')
      for (let index = 0; index < pieces.length; index++) {
        const piece = pieces[index]
        if (!lineWasTruncated) {
          const room = MAX_LINE_CHARS - currentLine.length
          if (piece.length > room) {
            currentLine += piece.slice(0, Math.max(0, room))
            lineWasTruncated = true
          } else {
            currentLine += piece
          }
        }
        if (index < pieces.length - 1 && !consumeLine()) break outer
      }
    }
    if (!hasMore) {
      const tail = decoder.decode()
      if (tail) {
        const room = MAX_LINE_CHARS - currentLine.length
        currentLine += tail.slice(0, Math.max(0, room))
        if (tail.length > room) lineWasTruncated = true
      }
      reachedEof = true
      // Empty files contain zero lines; non-empty files always have a final logical line.
      if (stat.size > 0 && currentLine.length > 0) consumeLine()
    }
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`File is not valid UTF-8 text: ${resolved}`)
    throw error
  } finally {
    stream.destroy()
  }

  if (output.length === 0) {
    if (stat.size === 0) return '(empty file)'
    if (reachedEof && lineNumber <= offset) {
      throw new Error(`Offset ${offset} is beyond the end of the file (${Math.max(0, lineNumber - 1)} lines)`)
    }
  }

  if (hasMore) {
    output.push(`... (output limited to ${limit} lines / 50KB; continue with offset=${offset + output.length})`)
  }
  return output.join('\n') || '(empty file)'
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
  const selected = entries.slice(start, start + limit)
  const result = selected.map(entry => `${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'l'} ${entry.name}${entry.isDirectory() ? '/' : ''}`)
  if (start + selected.length < entries.length) {
    result.push(`... (${entries.length - start - selected.length} more entries; continue with offset=${start + selected.length + 1})`)
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
  return [...oldLines, ...newLines, ...(clipped ? ['  ...'] : [])].join('\n')
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
