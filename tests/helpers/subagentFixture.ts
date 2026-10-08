import assert from 'node:assert/strict'
import { AgentAbortedError, type AppSettings, type Session, type UIMessage, type ToolCall } from '../../src/shared/types.ts'
import { SessionService } from '../../src/main/agent/sessionService.ts'
import type { SessionStore } from '../../src/main/agent/sessionContracts.ts'
import { PermissionBroker, type PermissionRequest } from '../../src/main/agent/permissionBroker.ts'
import type { AgentEventCallbacks, AgentRunOptions } from '../../src/main/agent/runner.ts'
import { ToolRegistry } from '../../src/main/tools/registry.ts'
import { createSubagentTools } from '../../src/main/tools/subagent.ts'
import type { SubagentModelSelection } from '../../src/shared/subagents.ts'

export function createSubagentTestProviders() { return [
  { id: 'a', name: 'A', baseUrl: 'https://a.test/v1', apiKey: 'secret-a', defaultModel: 'a-default', enabled: true },
  { id: 'b', name: 'B', baseUrl: 'https://b.test/v1', apiKey: 'secret-b', defaultModel: 'b-default', enabled: true },
  { id: 'off', name: 'Off', baseUrl: 'https://off.test', apiKey: 'secret-off', defaultModel: 'off', enabled: false }
] }

export function createSubagentFixture() {
  let sequence = 0
  const sessions = new Map<string, Session>()
  const messages = new Map<string, UIMessage[]>()
  const settings = { providers: createSubagentTestProviders(), activeProviderId: 'a', workspacePath: 'D:/shared', memoryEnabled: false, maxRounds: 20,
    subagentsEnabled: true, subagentModel: null } as AppSettings
  const store: SessionStore = {
    createSession(title = 'root', workspacePath, subagent) {
      const id = `s${++sequence}`
      const session: Session = { id, title, workspacePath, subagent, origin: 'renderer', createdAt: 1, updatedAt: 1,
        messageCount: 0, avatarEnabled: false, ttsEnabled: false }
      sessions.set(id, session); messages.set(id, []); return session
    },
    getSessions: () => [...sessions.values()], getSettings: () => settings, getSession: id => sessions.get(id) ?? null,
    updateSessionTitle: () => {}, updateSessionWorkspace: () => {},
    updateSessionModelSelection: (id, selection) => { sessions.get(id)!.modelSelection = selection },
    deleteSession: id => { sessions.delete(id); messages.delete(id) },
    getOrCreateBotSession: () => { throw new Error('unused') }, getMessages: id => [...messages.get(id)!],
    addMessage: message => { assert.ok(sessions.has(message.sessionId), 'no write after deletion'); messages.get(message.sessionId)!.push(message) },
    getSessionCompaction: () => null, setSessionCompaction: () => {}, tryUpdateSessionTitleIfDefault: () => false, addTokenUsage: () => {}
  }
  const running = new Map<string, { options: AgentRunOptions; callbacks: AgentEventCallbacks; resolve: () => void; reject: (error: unknown) => void }>()
  const permissions = new PermissionBroker()
  const pending: PermissionRequest[] = []
  permissions.addPresenter({ present: input => { pending.push(input) } })
  const tools = new ToolRegistry()
  for (const [name, permission, alwaysConfirm] of [['read', 'safe', false], ['write', 'normal', false], ['boundary', 'dangerous', true]] as const) {
    tools.register(name, { permission, alwaysConfirm, definition: { type: 'function', function: { name, description: name, parameters: {} } },
      execute: async () => ({ content: 'ok' }) }, name === 'read' ? 'mcp:test' : 'builtin')
  }
  let stuck = false
  let delayPrompt: (() => Promise<string>) | undefined
  const compactModels: { providerId: string; model: string | undefined }[] = []
  const service = new SessionService({ store, tools, permissions, getSkillsPrompt: () => '', getMcpStatus: () => [],
    getSystemPromptExtra: async id => sessions.get(id)?.subagent && delayPrompt ? delayPrompt() : '',
    executeAgent: async (options, callbacks) => new Promise((resolve, reject) => {
      running.set(options.sessionId!, { options, callbacks, resolve: () => resolve([]), reject })
      if (!(stuck && sessions.get(options.sessionId!)?.subagent)) {
        options.signal?.addEventListener('abort', () => reject(new AgentAbortedError()), { once: true })
      }
    }), fetchContextWindow: async (provider, model) => { compactModels.push({ providerId: provider.id, model }); return 32000 }, completeText: async () => '',
    planAutoCompact: async () => ({ beforeTokens: 0, afterTokens: 0, compressedCount: 0, keptCount: 0, keptOffset: 0, summary: null }) })
  for (const { name, handler } of createSubagentTools(service)) tools.register(name, handler)
  const finish = (id: string, text = 'delivered') => {
    const run = running.get(id)!
    run.callbacks.onAssistantMessage?.(text, []); run.callbacks.onComplete?.(); run.resolve()
  }
  const root = async (title = 'root', approveMode: 'manual' | 'auto' | 'full' = 'auto') => {
    const session = service.createSession(title, 'D:/parent-workspace')
    const handle = await service.sendMessage({ sessionId: session.id, message: { text: 'private parent history' },
      providerId: 'a', modelOverride: 'custom-a', reasoningEffort: 'high', approveMode, sourcePrompt: 'External source rules remain authoritative.' })
    void handle.completion.catch(() => {})
    const options = running.get(session.id)!.options
    return { session, handle, options, scope: service.getSubagentScope(session.id, options.signal) }
  }
  return { service, tools, permissions, pending, sessions, messages, running, finish, root, compactModels,
    setDelegation: (enabled: boolean) => { settings.subagentsEnabled = enabled },
    setChildModel: (model: SubagentModelSelection | null) => { settings.subagentModel = model },
    makeStuck: () => { stuck = true }, delayPrompt: (fn: () => Promise<string>) => { delayPrompt = fn } }
}

