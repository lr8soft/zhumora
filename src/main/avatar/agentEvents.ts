import type { AgentEventSink } from '../agent/persistedCallbacks'
import type { AvatarMessageTarget } from './contracts'

export function createAvatarAgentEventSink(target: AvatarMessageTarget): AgentEventSink {
  return {
    running: (sessionId, running) => target.setActivity(sessionId, running ? 'thinking' : 'idle'),
    aborted: sessionId => target.setActivity(sessionId, 'idle'),
    userMessage: message => target.setActivity(message.sessionId, 'thinking'),
    assistantStart: sessionId => target.setActivity(sessionId, 'thinking'),
    reasoning: sessionId => target.setActivity(sessionId, 'thinking'),
    token: sessionId => target.setActivity(sessionId, 'speaking'),
    toolCall: sessionId => target.setActivity(sessionId, 'thinking'),
    assistantEnd: (sessionId, _messageId, content) => {
      if (content) target.setMessage(sessionId, content)
    },
    complete: (sessionId, _messageId, content) => {
      target.setActivity(sessionId, 'idle')
      if (content) target.setMessage(sessionId, content)
    },
    error: (sessionId, error) => {
      target.setActivity(sessionId, 'idle')
      target.setMessage(sessionId, `Error: ${error.message}`)
    }
  }
}
