import type { AgentEventSink } from '../agent/persistedCallbacks.ts'
interface TtsAgentTarget {
  enqueue(sessionId: string, messageId: string, content: string): void
  stop(sessionId?: string): void
}

export function createTtsAgentEventSink(tts: TtsAgentTarget): AgentEventSink {
  return {
    aborted: sessionId => tts.stop(sessionId),
    userMessage: message => tts.stop(message.sessionId),
    assistantEnd: (sessionId, messageId, content) => tts.enqueue(sessionId, messageId, content),
    error: sessionId => tts.stop(sessionId)
  }
}
