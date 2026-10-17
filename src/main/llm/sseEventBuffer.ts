import { SseLineBuffer } from './sseAccumulator.ts'

/** One SSE event can contain multiple data lines; parse JSON only after the event is assembled. */
export class SseEventBuffer {
  private readonly lines = new SseLineBuffer()
  private data: string[] = []

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
    if (line === 'data') this.data.push('')
    else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''))
    // Comments and SSE metadata (event/id/retry) are not chat completion payloads.
  }

  private dispatch(onData: (data: string) => void): void {
    if (!this.data.length) return
    const data = this.data.join('\n').trim()
    this.data = []
    onData(data)
  }
}
