import { SseLineBuffer } from './sseAccumulator.ts'
import { ProviderStreamError } from './streamErrors.ts'

/** One SSE event can contain multiple data lines; parse JSON only after the event is assembled. */
export class SseEventBuffer {
  private readonly lines: SseLineBuffer
  private data: string[] = []
  private dataChars = 0
  private readonly maxEventChars: number

  constructor(maxEventChars = 8 * 1024 * 1024) {
    this.maxEventChars = maxEventChars
    this.lines = new SseLineBuffer(maxEventChars)
  }

  feed(chunk: string, onData: (data: string) => void): void {
    this.lines.feed(chunk, line => this.line(line, onData))
  }

  flush(onData: (data: string) => void): void {
    this.lines.flush(line => this.line(line, onData))
    // Preserve compatibility with a valid final event that has no terminating blank line.
    this.dispatch(onData)
  }

  private line(line: string, onData: (data: string) => void): void {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line) { this.dispatch(onData); return }
    if (line === 'data' || line.startsWith('data:')) {
      const value = line === 'data' ? '' : line.slice(5).replace(/^ /, '')
      this.dataChars += value.length + 1
      if (this.dataChars > this.maxEventChars) throw new ProviderStreamError('payload', { reason: 'SSE event exceeds response limit', limit: this.maxEventChars })
      this.data.push(value)
    }
    // Comments and SSE metadata (event/id/retry) are not chat completion payloads.
  }

  private dispatch(onData: (data: string) => void): void {
    if (!this.data.length) return
    const data = this.data.join('\n').trim()
    this.data = []
    this.dataChars = 0
    onData(data)
  }
}
