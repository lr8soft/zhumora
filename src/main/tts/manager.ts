import type { WebContents } from 'electron'
import type { AppSettings, Session } from '../../shared/types.ts'
import { equivalentTtsModels, prepareSpeechText, type TtsModelConfig } from '../../shared/tts.ts'
import { generateId } from '../id.ts'
import { inspectTtsModelDirectory, SherpaOnnxTtsProvider } from './sherpaProvider.ts'

export interface TtsProvider {
  synthesize(text: string, model: TtsModelConfig, signal: AbortSignal): Promise<{ samples: Float32Array; sampleRate: number }>
  reset(): void
}

interface TtsStore {
  getSession(id: string): Session | null
  getSettings(): AppSettings
}

export class TtsManager {
  private readonly provider: TtsProvider
  private readonly store: TtsStore
  private renderer: WebContents | undefined
  private current: { sessionId: string; abort: AbortController } | undefined
  private outputSessionId: string | undefined

  constructor(store: TtsStore, provider: TtsProvider = new SherpaOnnxTtsProvider()) {
    this.store = store
    this.provider = provider
  }

  attachRenderer(renderer: WebContents): void { this.renderer = renderer }

  async importModel(directory: string): Promise<TtsModelConfig> {
    return inspectTtsModelDirectory(directory, generateId())
  }

  complete(sessionId: string, messageId: string, content: string): void {
    const session = this.store.getSession(sessionId)
    if (!session?.ttsEnabled) return
    const settings = this.store.getSettings()
    const model = settings.ttsModels.find(item => item.id === settings.defaultTtsModelId)
    const text = prepareSpeechText(content)
    if (!model || !text) return
    this.abortCurrent()
    this.stopOutput()
    const abort = new AbortController()
    this.current = { sessionId, abort }
    void this.provider.synthesize(text, model, abort.signal).then(audio => {
      if (abort.signal.aborted || this.current?.abort !== abort) return
      this.outputSessionId = sessionId
      this.send('tts:audio', { sessionId, messageId, samples: audio.samples, sampleRate: audio.sampleRate })
    }).catch(error => {
      if (abort.signal.aborted) return
      this.send('tts:error', { sessionId, error: error instanceof Error ? error.message : String(error) })
    }).finally(() => {
      if (this.current?.abort === abort) this.current = undefined
    })
  }

  stop(sessionId?: string): void {
    if (!sessionId || this.current?.sessionId === sessionId) this.abortCurrent()
    this.stopOutput(sessionId)
  }

  applySettings(next: AppSettings, previous: AppSettings): void {
    if (equivalentTtsModels(next.ttsModels, previous.ttsModels)
      && next.defaultTtsModelId === previous.defaultTtsModelId) return
    this.abortCurrent()
    this.stopOutput()
    this.provider.reset()
  }

  dispose(): void { this.abortCurrent(); this.stopOutput(); this.renderer = undefined; this.provider.reset() }

  private abortCurrent(): void {
    const current = this.current
    if (!current) return
    current.abort.abort()
    this.current = undefined
  }

  private stopOutput(sessionId?: string): void {
    if (!this.outputSessionId || (sessionId && this.outputSessionId !== sessionId)) return
    const stoppedSessionId = this.outputSessionId
    this.outputSessionId = undefined
    this.send('tts:stop', { sessionId: stoppedSessionId })
  }

  private send(channel: string, payload: object): void {
    if (this.renderer && !this.renderer.isDestroyed()) this.renderer.send(channel, payload)
  }
}
