import type { AgentEventSink } from '../agent/persistedCallbacks'
import type { AvatarMessageTarget } from './contracts'

export function createAvatarAgentEventSink(target: AvatarMessageTarget): AgentEventSink {
  return {
    assistantEnd: (sessionId, _messageId, content) => {
      if (content) target.setMessage(sessionId, content)
    },
    complete: (sessionId, _messageId, content) => {
      if (content) target.setMessage(sessionId, content)
    },
    error: (sessionId, error) => target.setMessage(sessionId, `Error: ${error.message}`)
  }
}
