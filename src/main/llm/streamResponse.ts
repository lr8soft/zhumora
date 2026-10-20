import { applySseData, type SseApplyResult, type StreamAccumulator } from './sseAccumulator.ts'
import { SseEventBuffer } from './sseEventBuffer.ts'
import { IncompleteStreamError, ProviderStreamError } from './streamErrors.ts'
import { isStreamableNetworkError } from '../net/retryCore.ts'
import type { StreamErrorContext } from './providerErrorDetails.ts'
import type { GenerationMetadata } from '../../shared/generation.ts'
import { retryAfterMilliseconds } from './responseParsing.ts'

export interface StreamReadPolicy { progressTimeoutMs?: number; terminalTimeoutMs?: number; captureFrames?: boolean; signal?: AbortSignal }

/** Network activity and generation progress deliberately have different clocks. */
export async function readChatStream(response: Response, acc: StreamAccumulator,
  onDelta: (delta: SseApplyResult) => void, onActivity: () => void, context?: StreamErrorContext,
  policy: StreamReadPolicy = {}): Promise<void> {
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  const reader = response.body?.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const sse = new SseEventBuffer()
  const started = Date.now()
  let progressAt = started; let terminalAt = 0; let frames = 0; let bytes = 0
  const rawFrames: string[] = []; let traceBytes = 0; let traceOmitted = false; let failed = false
  const diagnostics = { ...context, requestId: response.headers.get('x-request-id')
    ?? response.headers.get('request-id') ?? response.headers.get('x-generation-id') ?? context?.requestId,
    retryAfterMs: retryAfterMilliseconds(response.headers) }
  const handle = (data: string) => {
    frames++
    if (acc.done && data && data !== '[DONE]') acc.generation = { version: 1, status: 'complete', ...acc.generation,
      warnings: [...(acc.generation?.warnings ?? []), 'Data received after [DONE] was ignored.'] }
    if (policy.captureFrames) {
      if (data.length > 262144) traceOmitted = true
      else {
        rawFrames.push(data); traceBytes += data.length
        while (traceBytes > 262144 || rawFrames.length > 32) {
          traceBytes -= rawFrames.shift()!.length; traceOmitted = true
        }
      }
    }
    const delta = applySseData(acc, data, diagnostics)
    if (delta.emitted) progressAt = Date.now()
    if (acc.finishReason && !terminalAt) terminalAt = Date.now()
    onDelta(delta)
  }
  let termination: GenerationMetadata['termination'] = 'eof'
  try {
    if (mime && mime !== 'text/event-stream' && mime !== 'text/plain') {
      // Read through the response, not its locked stream, to preserve the original error body.
      const raw = await readBody(reader, decoder, policy.signal)
      let payload: unknown
      try { payload = JSON.parse(raw) } catch { payload = raw }
      if (payload && typeof payload === 'object' && 'error' in payload) {
        throw new ProviderStreamError('provider', payload.error, diagnostics)
      }
      throw new ProviderStreamError('payload', { reason: 'Expected SSE response', contentType: mime, body: payload })
    }
    if (!reader) throw new IncompleteStreamError()
    while (!acc.done) {
      const timeout = terminalAt
        ? terminalAt + (policy.terminalTimeoutMs ?? 5000) - Date.now()
        : progressAt + (policy.progressTimeoutMs ?? 600_000) - Date.now()
      const next = await readWithDeadline(reader, Math.max(0, timeout), policy.signal)
      if (next === 'timeout') {
        if (canAcceptTextTail(acc)) { termination = 'tail_timeout'; break }
        termination = 'timeout'
        throw new IncompleteStreamError(terminalAt ? 'terminal_timeout' : 'progress_timeout')
      }
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 64 * 1024 * 1024) throw new ProviderStreamError('payload', { reason: 'SSE response exceeds 64 MiB limit' }, diagnostics)
      onActivity()
      sse.feed(decoder.decode(next.value, { stream: true }), handle)
    }
    sse.feed(decoder.decode(), handle)
    sse.flush(handle)
    if (!acc.finishReason) throw new IncompleteStreamError()
    if (acc.done) termination = 'done'
  } catch (error) {
    if (!(error instanceof ProviderStreamError) && canAcceptTextTail(acc) && isStreamableNetworkError(error)) {
      termination = 'tail_error'
    } else {
      failed = true
      if (termination !== 'timeout') termination = 'error'
      if (error instanceof IncompleteStreamError) acc.generation = { version: 1, status: 'incomplete', ...acc.generation, reason: error.reason }
      throw error
    }
  } finally {
    acc.generation = { version: 1, status: 'complete', ...acc.generation, termination,
      ...(failed ? { status: 'incomplete' as const } : {}),
      ...(diagnostics.requestId != null ? { requestId: String(diagnostics.requestId) } : {}),
      frameCount: frames, byteCount: bytes, durationMs: Date.now() - started,
      ...(policy.captureFrames ? { rawFrames, traceOmitted } : {}),
      ...((termination === 'tail_error' || termination === 'tail_timeout')
        ? { warnings: [...(acc.generation?.warnings ?? []), 'Text finished; optional stream tail was unavailable.'] } : {}) }
    if (reader) {
      try { void reader.cancel().catch(() => {}) } catch { /* Transport cleanup must not block settlement. */ }
      reader.releaseLock()
    }
  }
}

function canAcceptTextTail(acc: StreamAccumulator): boolean {
  return acc.finishReason === 'stop' && !!acc.content.trim() && !acc.toolCalls.size && !acc.refusal
}

async function readBody(reader: ReadableStreamDefaultReader<Uint8Array> | undefined, decoder: InstanceType<typeof TextDecoder>, signal?: AbortSignal) {
  let text = ''
  if (reader) for (;;) {
    const next = await readWithDeadline(reader, 1000, signal)
    if (next === 'timeout') return text + '\n[Response body did not finish]'
    if (next.done) break
    text += decoder.decode(next.value, { stream: true })
  }
  return text + decoder.decode()
}

async function readWithDeadline(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number, signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  try {
    return await Promise.race([reader.read(), new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), ms)
    }), new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      signal?.addEventListener('abort', onAbort, { once: true })
    })])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}
