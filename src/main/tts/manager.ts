import type { WebContents } from 'electron'
import type { AppSettings, Session } from '../../shared/types.ts'
import { equivalentTtsModels, splitSpeechText, type TtsModelConfig } from '../../shared/tts.ts'
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

interface SpeechJob {
  sessionId: string
  messageId: string
  text: string
  model: TtsModelConfig
}

export class TtsManager {
  private readonly provider: TtsProvider
  private readonly store: TtsStore
  private renderer: WebContents | undefined
  private queue: SpeechJob[] = []
  private current: { job: SpeechJob; abort: AbortController } | undefined
  private readonly outputSessions = new Set<string>()
  private resetPending = false
  private disposed = false

  constructor(store: TtsStore, provider: TtsProvider = new SherpaOnnxTtsProvider()) {
    this.store = store
    this.provider = provider
  }

  attachRenderer(renderer: WebContents): void { this.renderer = renderer }

  async importModel(directory: string): Promise<TtsModelConfig> {
    return inspectTtsModelDirectory(directory, generateId())
  }

  enqueue(sessionId: string, messageId: string, content: string): void {
    if (this.disposed || !this.store.getSession(sessionId)?.ttsEnabled) return
    const settings = this.store.getSettings()
    const model = settings.ttsModels.find(item => item.id === settings.defaultTtsModelId)
    if (!model) return
    for (const text of splitSpeechText(content)) this.queue.push({ sessionId, messageId, text, model })
    this.pump()
  }

  stop(sessionId?: string): void {
    this.queue = sessionId ? this.queue.filter(job => job.sessionId !== sessionId) : []
    if (this.current && (!sessionId || this.current.job.sessionId === sessionId)) this.current.abort.abort()
    this.stopOutput(sessionId)
  }

  applySettings(next: AppSettings, previous: AppSettings): void {
    if (equivalentTtsModels(next.ttsModels, previous.ttsModels)
      && next.defaultTtsModelId === previous.defaultTtsModelId) return
    this.stop()
    this.resetPending = true
    this.flushReset()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.renderer = undefined
    this.resetPending = true
    this.flushReset()
  }

  private pump(): void {
    if (this.disposed || this.current || this.resetPending) return
    const job = this.queue.shift()
    if (!job) return
    if (!this.store.getSession(job.sessionId)?.ttsEnabled) {
      this.pump()
      return
    }
    const abort = new AbortController()
    this.current = { job, abort }
    void this.provider.synthesize(job.text, job.model, abort.signal).then(audio => {
      if (abort.signal.aborted || this.current?.abort !== abort) return
      this.outputSessions.add(job.sessionId)
      this.send('tts:audio', {
        sessionId: job.sessionId,
        messageId: job.messageId,
        samples: audio.samples,
        sampleRate: audio.sampleRate
      })
    }).catch(error => {
      if (!abort.signal.aborted) {
        this.send('tts:error', { sessionId: job.sessionId, error: error instanceof Error ? error.message : String(error) })
      }
    }).finally(() => {
      if (this.current?.abort === abort) this.current = undefined
      this.flushReset()
      this.pump()
    })
  }

  private flushReset(): void {
    if (!this.resetPending || this.current) return
    this.resetPending = false
    this.provider.reset()
  }

  private stopOutput(sessionId?: string): void {
    const sessions = sessionId
      ? this.outputSessions.has(sessionId) ? [sessionId] : []
      : [...this.outputSessions]
    for (const stoppedSessionId of sessions) {
      this.outputSessions.delete(stoppedSessionId)
      this.send('tts:stop', { sessionId: stoppedSessionId })
    }
  }

  private send(channel: string, payload: object): void {
    if (this.renderer && !this.renderer.isDestroyed()) this.renderer.send(channel, payload)
  }
}
