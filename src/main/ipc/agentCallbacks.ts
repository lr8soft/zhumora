import type { AgentEventSink } from '../agent/persistedCallbacks'
import type { PermissionPresenter } from '../agent/permissionBroker'

/** Maps platform-neutral Agent events onto the renderer IPC contract. */
export function createIpcAgentEventSink(sender: Electron.WebContents): AgentEventSink {
  return {
    running: (sessionId, running) => sender.send('agent:running', { sessionId, running }),
    aborted: sessionId => sender.send('agent:aborted', { sessionId }),
    titleUpdated: (sessionId, title) => sender.send('session:title_updated', { sessionId, title }),
    userMessage: (message, source) => {
      if (source === 'external') sender.send('agent:user_message', { sessionId: message.sessionId, message })
    },
    assistantStart: (sessionId, messageId) => {
      sender.send('agent:assistant_message', { sessionId, messageId, content: '', toolCalls: [], phase: 'start' })
    },
    token: (sessionId, messageId, token) => sender.send('agent:token', { sessionId, messageId, token }),
    reasoning: (sessionId, messageId, token) => sender.send('agent:reasoning', { sessionId, messageId, token }),
    toolCall: (sessionId, messageId, toolCall) => sender.send('agent:tool_call', { sessionId, messageId, toolCall }),
    toolResult: (message, toolCallId, toolName, result, isError, durationMs) => {
      sender.send('agent:tool_result', {
        sessionId: message.sessionId,
        messageId: message.id,
        toolCallId,
        toolName,
        result,
        isError,
        durationMs
      })
    },
    assistantEnd: (sessionId, messageId, content, toolCalls, reasoning) => {
      sender.send('agent:assistant_message', {
        sessionId, messageId, content, toolCalls, phase: 'end', reasoning
      })
    },
    complete: (sessionId, messageId, content) => {
      sender.send('agent:complete', { sessionId, messageId, content })
    },
    error: (sessionId, error) => sender.send('agent:error', { sessionId, error: error.message }),
    retry: (sessionId, failedAttempt, maxRetries) => {
      sender.send('agent:retry', { sessionId, failedAttempt, maxRetries })
    },
    truncated: (sessionId, kind, reason) => sender.send('agent:truncated', { sessionId, kind, reason }),
    compact: (sessionId, info) => sender.send('agent:compact', { sessionId, ...info })
  }
}

export function createIpcPermissionPresenter(sender: Electron.WebContents): PermissionPresenter {
  return {
    present: request => {
      if (sender.isDestroyed()) return
      sender.send('agent:permission_request', {
        sessionId: request.sessionId,
        permId: request.id,
        toolName: request.toolName,
        args: request.args,
        level: request.level
      })
    },
    resolve: (request, resolution) => {
      if (sender.isDestroyed()) return
      sender.send('agent:permission_resolved', {
        sessionId: request.sessionId,
        permId: request.id,
        resolution
      })
    }
  }
}
