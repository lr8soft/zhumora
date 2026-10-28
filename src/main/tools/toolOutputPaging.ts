import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { MAX_TOOL_LINE_CHARS, MAX_TOOL_OUTPUT_CHARS, MAX_TOOL_OUTPUT_LINES } from './outputLimits.ts'

export interface ToolOutputReadOptions {
  offset?: number
  limit?: number
  char_offset?: number
  pattern?: string
  signal?: AbortSignal
}

function integer(value: unknown, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function safeEnd(text: string, start: number, length: number): number {
  let end = Math.min(text.length, start + length)
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] || '')) end--
  return end
}

/** Cursors address the original lines, including unfinished long lines; previews never skip text. */
export async function readOutputPage(filePath: string, options: ToolOutputReadOptions): Promise<string> {
  const offset = integer(options.offset, 1, 1)
  const limit = Math.min(integer(options.limit, 200, 1, MAX_TOOL_OUTPUT_LINES), MAX_TOOL_OUTPUT_LINES - 3)
  const charOffset = integer(options.char_offset, 0, 0)
  if (options.pattern !== undefined && (typeof options.pattern !== 'string' || !options.pattern || options.pattern.length > 2_000)) {
    throw new Error('pattern must be a nonempty literal string of at most 2000 characters')
  }
  options.signal?.throwIfAborted()
  const stream = createReadStream(filePath, { encoding: 'utf8', signal: options.signal })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const lines: string[] = []
  let lineNumber = 0
  let chars = 0
  let nextOffset = 0
  let nextCharOffset = 0
  try {
    for await (const line of reader) {
      options.signal?.throwIfAborted()
      lineNumber++
      if (lineNumber < offset) continue
      const start = lineNumber === offset ? charOffset : 0
      if (start > line.length) throw new Error('char_offset is beyond the requested line')
      if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start] || '') && /[\uD800-\uDBFF]/.test(line[start - 1])) {
        throw new Error('char_offset splits a Unicode character; use the returned cursor')
      }
      if (options.pattern && !line.includes(options.pattern)) continue
      if (lines.length >= limit || chars >= MAX_TOOL_OUTPUT_CHARS - 512) {
        nextOffset = lineNumber; break
      }
      const prefix = `${lineNumber}${start ? `:${start}` : ''}: `
      const room = Math.min(MAX_TOOL_LINE_CHARS - prefix.length, MAX_TOOL_OUTPUT_CHARS - 512 - chars - prefix.length - 1)
      const end = safeEnd(line, start, Math.max(2, room))
      const rendered = `${prefix}${line.slice(start, end)}`
      lines.push(rendered); chars += rendered.length + 1
      if (end < line.length) {
        nextOffset = lineNumber; nextCharOffset = end; break
      }
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  if (lineNumber < offset && (lineNumber > 0 || offset > 1 || charOffset > 0)) throw new Error('offset is beyond the output')
  const body = lines.join('\n') || (options.pattern ? '(no matching lines)' : '(empty output)')
  const continuation = nextOffset
    ? `has_more=true truncated=true next_offset=${nextOffset} next_char_offset=${nextCharOffset}. Continue with the same output_id${options.pattern ? ' and pattern' : ''}, offset=${nextOffset}, char_offset=${nextCharOffset}.`
    : 'has_more=false truncated=false (end of output)'
  return `${body}\n[${continuation}]`
}
