import type { TtsAudioPayload } from '@shared/tts'

class TtsPlaybackController {
  private context: AudioContext | undefined
  private current: { sessionId: string; source: AudioBufferSourceNode } | undefined

  async unlock(): Promise<void> {
    this.context ??= new AudioContext()
    if (this.context.state === 'suspended') await this.context.resume()
  }

  async play(payload: TtsAudioPayload): Promise<void> {
    await this.unlock()
    this.stop()
    const incoming = payload.samples instanceof Float32Array ? payload.samples : new Float32Array(payload.samples)
    const samples = new Float32Array(incoming.length)
    samples.set(incoming)
    if (!samples.length || !Number.isFinite(payload.sampleRate) || payload.sampleRate < 8000) throw new Error('TTS returned invalid audio.')
    const buffer = this.context!.createBuffer(1, samples.length, payload.sampleRate)
    buffer.copyToChannel(samples, 0)
    const source = this.context!.createBufferSource()
    source.buffer = buffer
    source.connect(this.context!.destination)
    this.current = { sessionId: payload.sessionId, source }
    source.onended = () => { if (this.current?.source === source) this.current = undefined }
    source.start()
  }

  stop(sessionId?: string): void {
    if (!this.current || (sessionId && this.current.sessionId !== sessionId)) return
    const source = this.current.source
    this.current = undefined
    source.onended = null
    try { source.stop() } catch { /* source may already have ended */ }
    source.disconnect()
  }

  dispose(): void {
    this.stop()
    void this.context?.close()
    this.context = undefined
  }
}

export const ttsPlayback = new TtsPlaybackController()
