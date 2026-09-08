import type { TtsAudioPayload } from '@shared/tts'
import { TtsPlaybackQueue } from './playbackQueue'

class TtsPlaybackController {
  private context: AudioContext | undefined
  private readonly queue = new TtsPlaybackQueue()
  private readonly versions = new Map<string, number>()
  private preparation: Promise<void> = Promise.resolve()
  private disposed = false

  async unlock(): Promise<void> {
    this.context ??= new AudioContext()
    if (this.context.state === 'suspended') await this.context.resume()
  }

  play(payload: TtsAudioPayload): Promise<void> {
    const version = this.versions.get(payload.sessionId) || 0
    const scheduled = this.preparation.then(async () => {
      await this.unlock()
      if (this.disposed || version !== (this.versions.get(payload.sessionId) || 0)) return
      const incoming = payload.samples instanceof Float32Array ? payload.samples : new Float32Array(payload.samples)
      const samples = new Float32Array(incoming.length)
      samples.set(incoming)
      if (!samples.length || !Number.isFinite(payload.sampleRate) || payload.sampleRate < 8000) {
        throw new Error('TTS returned invalid audio.')
      }
      const buffer = this.context!.createBuffer(1, samples.length, payload.sampleRate)
      buffer.copyToChannel(samples, 0)
      const source = this.context!.createBufferSource()
      source.buffer = buffer
      source.connect(this.context!.destination)
      this.queue.enqueue({
        sessionId: payload.sessionId,
        start: onEnded => {
          source.onended = () => { source.disconnect(); onEnded() }
          source.start()
        },
        stop: () => {
          source.onended = null
          try { source.stop() } catch { /* source may already have ended */ }
          source.disconnect()
        }
      })
    })
    this.preparation = scheduled.catch(() => {})
    return scheduled
  }

  stop(sessionId?: string): void {
    if (sessionId) this.versions.set(sessionId, (this.versions.get(sessionId) || 0) + 1)
    else for (const id of this.versions.keys()) this.versions.set(id, (this.versions.get(id) || 0) + 1)
    this.queue.stop(sessionId)
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    void this.context?.close()
    this.context = undefined
  }
}

export const ttsPlayback = new TtsPlaybackController()
