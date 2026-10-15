/** Text previews are bounded at the producing tool; these are not provider concurrency or token limits. */
export const MAX_TOOL_OUTPUT_CHARS = 48_000
export const MAX_TOOL_OUTPUT_LINES = 2_000
export const MAX_TOOL_LINE_CHARS = 2_000
export const MAX_COMMAND_OUTPUT_LINES = 500

function prefix(text: string, length: number): string {
  let end = Math.min(length, text.length)
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
  return text.slice(0, end)
}

function suffix(text: string, length: number): string {
  let start = Math.max(0, text.length - length)
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) start++
  return text.slice(start)
}

function lastLines(text: string, count: number): string {
  let position = text.length - (text.endsWith('\n') ? 2 : 1)
  for (let kept = 0; kept < count; kept++) {
    const newline = text.lastIndexOf('\n', position)
    if (newline < 0) return text
    position = newline - 1
  }
  return text.slice(position + 2)
}

function shortenLines(text: string): string {
  return text.split('\n').map(line => {
    if (line.length <= MAX_TOOL_LINE_CHARS) return line
    const marker = ' …[line truncated]… '
    const room = Math.floor((MAX_TOOL_LINE_CHARS - marker.length) / 2)
    return prefix(line, room) + marker + suffix(line, room)
  }).join('\n')
}

/** Per-command/per-query owner. Keeps a bounded prefix and rolling suffix, even for a single huge stream. */
export class BoundedToolOutput {
  private head = ''
  private tail = ''
  private headClosed = false
  private headNewlines = 0
  private totalChars = 0
  private totalNewlines = 0
  private endsInNewline = false
  private readonly halfChars = Math.floor((MAX_TOOL_OUTPUT_CHARS - 512) / 2)
  private readonly headLines: number
  private readonly tailLines: number
  private readonly hint: string

  constructor(hint: string, maxLines = MAX_TOOL_OUTPUT_LINES) {
    this.hint = hint
    if (!Number.isInteger(maxLines) || maxLines < 4 || maxLines > MAX_TOOL_OUTPUT_LINES) throw new Error('Invalid output line limit')
    this.headLines = Math.floor((maxLines - 3) / 2)
    this.tailLines = maxLines - 3 - this.headLines
  }

  append(text: string): void {
    if (!text) return
    this.totalChars += text.length
    for (const character of text) if (character === '\n') this.totalNewlines++
    this.endsInNewline = text.endsWith('\n')
    if (!this.headClosed) {
      const candidate = prefix(text, this.halfChars - this.head.length)
      let end = 0
      while (end < candidate.length) {
        const newline = candidate.indexOf('\n', end)
        if (newline < 0) { end = candidate.length; break }
        end = newline + 1
        if (++this.headNewlines >= this.headLines) { this.headClosed = true; break }
      }
      this.head += prefix(candidate, end)
      if (candidate.length < text.length || this.head.length >= this.halfChars - 1) this.headClosed = true
    }
    this.tail = lastLines(suffix(this.tail + suffix(text, this.halfChars), this.halfChars), this.tailLines)
  }

  snapshot(): { text: string; totalChars: number; totalLines: number; truncated: boolean; retainedChars: number } {
    const omitted = this.totalChars > this.head.length + this.tail.length
    const body = omitted ? `${this.head}${this.head.endsWith('\n') ? '' : '\n'}[... middle output omitted ...]\n${this.tail}`
      : this.head + this.tail.slice(Math.max(0, this.head.length + this.tail.length - this.totalChars))
    const shortened = shortenLines(body)
    const truncated = omitted || shortened !== body
    const totalLines = this.totalNewlines + (this.totalChars && !this.endsInNewline ? 1 : 0)
    const notice = `[Output truncated: ${this.totalChars} characters, ${totalLines} lines total. ${this.hint}]`
    return { text: truncated ? `${shortened}${shortened.endsWith('\n') ? '' : '\n'}${notice}` : shortened, totalChars: this.totalChars, totalLines,
      truncated, retainedChars: this.head.length + this.tail.length }
  }
}

export function limitToolOutput(text: string, hint: string): string {
  const output = new BoundedToolOutput(hint)
  output.append(text)
  return output.snapshot().text
}

/** A model may request a shorter preview but cannot remove the tool's hard ceiling. */
export function browserOutputLength(value: unknown): number {
  if (value === undefined) return 5_000
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('max_length must be a positive integer')
  return Math.min(value, MAX_TOOL_OUTPUT_CHARS)
}

export function browserTextPreview(text: string, requestedLength: unknown): string {
  const length = browserOutputLength(requestedLength)
  const preview = text.length > length ? `${prefix(text, length)}\n[Page content truncated; use a narrower selector.]` : text
  return limitToolOutput(preview, 'Use a narrower selector to inspect the omitted page content.')
}
