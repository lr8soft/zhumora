export interface QueuedAudio {
  sessionId: string
  start(onEnded: () => void): void
  stop(): void
}

export class TtsPlaybackQueue {
  private pending: QueuedAudio[] = []
  private current: QueuedAudio | undefined

  enqueue(audio: QueuedAudio): void {
    this.pending.push(audio)
    this.startNext()
  }

  stop(sessionId?: string): void {
    const removed = sessionId ? this.pending.filter(audio => audio.sessionId === sessionId) : this.pending
    this.pending = sessionId ? this.pending.filter(audio => audio.sessionId !== sessionId) : []
    const stopCurrent = !!this.current && (!sessionId || this.current.sessionId === sessionId)
    if (stopCurrent) {
      const current = this.current!
      this.current = undefined
      current.stop()
    }
    for (const audio of removed) audio.stop()
    if (stopCurrent) this.startNext()
  }

  private startNext(): void {
    if (this.current) return
    const audio = this.pending.shift()
    if (!audio) return
    this.current = audio
    try {
      audio.start(() => {
        if (this.current !== audio) return
        this.current = undefined
        this.startNext()
      })
    } catch (error) {
      this.current = undefined
      audio.stop()
      this.startNext()
      throw error
    }
  }
}
