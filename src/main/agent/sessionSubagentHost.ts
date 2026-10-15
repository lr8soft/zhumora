import { AgentAbortedError, type Session } from '../../shared/types.ts'
import type { SessionStore, SessionRunRequest, SessionRunHandle } from './sessionContracts.ts'
import type { SubagentHost } from './subagentScope.ts'
import { assertSubagentsEnabled } from './subagentPolicy.ts'

interface HostDependencies {
  store: Pick<SessionStore, 'getSettings' | 'getSession' | 'createSession'>
  session: Session
  parentModel: { providerId: string; model: string }
  resolveModel: SubagentHost['resolveModel']
  signal: AbortSignal
  request: SessionRunRequest
  send: (request: SessionRunRequest) => Promise<SessionRunHandle>
  sendMessage: NonNullable<SubagentHost['sendMessage']>
  isRunning: SubagentHost['isRunning']
  stop: SubagentHost['stop']
  waitIdle: SubagentHost['waitIdle']
}

/** Host construction holds no run state; all execution/cancellation stays in SessionService. */
export function createSessionSubagentHost(deps: HostDependencies): SubagentHost {
  const { store, session, signal, request, parentModel } = deps
  return {
    workspacePath: session.workspacePath || store.getSettings().workspacePath,
    assertEnabled: () => assertSubagentsEnabled(store.getSettings().subagentsEnabled),
    resolveModel: deps.resolveModel,
    createSession: (description, model) => {
      if (signal.aborted) throw new AgentAbortedError()
      return store.createSession(description, session.workspacePath || store.getSettings().workspacePath,
        { parentSessionId: session.id, ...model })
    },
    start: (childId, prompt, localEvents, presenter, subagentAssignment) => {
      const child = store.getSession(childId)?.subagent
      return deps.send({ sessionId: childId, message: { text: prompt }, inputSource: 'external',
        providerId: child?.providerId, modelOverride: child?.model, signal, localEvents, subagentAssignment,
        sourcePrompt: request.sourcePrompt, permissionPresenters: [...(request.permissionPresenters || []), presenter],
        permissionTimeoutMs: request.permissionTimeoutMs,
        reasoningEffort: parentModel.providerId === child?.providerId && parentModel.model === child?.model ? request.reasoningEffort : undefined })
    },
    sendMessage: deps.sendMessage, isRunning: deps.isRunning, stop: deps.stop, waitIdle: deps.waitIdle
  }
}
