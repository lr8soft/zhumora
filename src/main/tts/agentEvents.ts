import type { AgentEventSink } from '../agent/persistedCallbacks.ts'
import type { TtsManager } from './manager.ts'

export function createTtsAgentEventSink(tts: TtsManager): AgentEventSink {
  return {
    userMessage: message => tts.stop(message.sessionId),
    complete: (sessionId, messageId, content) => tts.complete(sessionId, messageId, content)
  }
}
