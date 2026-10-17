import { applySseData, type SseApplyResult, type StreamAccumulator } from './sseAccumulator.ts'
import { SseEventBuffer } from './sseEventBuffer.ts'
import { IncompleteStreamError, ProviderStreamError } from './streamErrors.ts'

/** Read one HTTP attempt. The caller owns cancellation, retries, timers and partial-result policy. */
export async function readChatStream(response: Response, acc: StreamAccumulator,
  onDelta: (delta: SseApplyResult) => void, onActivity: () => void): Promise<void> {
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  const reader = response.body?.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const sse = new SseEventBuffer()
  const handleData = (data: string) => onDelta(applySseData(acc, data))
  try {
    // Some compatible proxies omit the MIME or return text/plain; still require valid SSE chat frames.
    if (mime && mime !== 'text/event-stream' && mime !== 'text/plain') throw new ProviderStreamError('content_type')
    if (!reader) throw new IncompleteStreamError()
    while (!acc.done) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity()
      sse.feed(decoder.decode(value, { stream: true }), handleData)
    }
    sse.feed(decoder.decode(), handleData)
    sse.flush(handleData)
    // DONE alone is not evidence that the assistant response is complete. Conversely, allow
    // finish_reason + EOF for compatible endpoints that omit DONE; usage-only tails remain valid.
    if (!acc.finishReason) throw new IncompleteStreamError()
  } finally {
    // A DONE sentinel may arrive on a connection that stays open. Release its network slot now.
    if (reader) {
      // Some transports never settle cancel(). Do not let cleanup block the outcome or permit release.
      try { void reader.cancel().catch(() => {}) } catch { /* Best-effort transport cleanup. */ }
      reader.releaseLock()
    }
  }
}
