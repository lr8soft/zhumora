import assert from 'node:assert/strict'
import { AgentAbortedError, type AppSettings, type Session, type UIMessage } from '../src/shared/types.ts'
import { PermissionBroker } from '../src/main/agent/permissionBroker.ts'
import { SessionBusyError, SessionService, type SessionStore } from '../src/main/agent/sessionService.ts'
import type { AgentEventCallbacks, AgentRunOptions } from '../src/main/agent/runner.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'

const settings = {
  providers: [{
    id: 'provider', name: 'Provider', baseUrl: 'http://localhost', apiKey: '',
    defaultModel: 'model', enabled: true
  }],
  activeProviderId: 'provider', workspacePath: 'D:/workspace', memoryEnabled: false, maxRounds: 20,
  mcpServers: [], skills: [],
  telegramBot: { enabled: false, token: '', allowedUserIds: [], approveMode: 'manual' },
  qqBot: { enabled: false, appId: '', appSecret: '', allowedUserIds: [], approveMode: 'manual' },
  avatarModels: [], defaultAvatarModelId: null, avatarWindowSize: { width: 400, height: 600 },
  ttsModels: [], defaultTtsModelId: null
} as AppSettings

const sessions = new Map<string, Session>([
  ['s1', { id: 's1', title: 'Session one', createdAt: 1, updatedAt: 1, messageCount: 0, avatarEnabled: false, ttsEnabled: false }],
  ['s2', { id: 's2', title: 'Session two', createdAt: 1, updatedAt: 1, messageCount: 0, avatarEnabled: false, ttsEnabled: false }]
])
const messages = new Map<string, UIMessage[]>([['s1', []], ['s2', []]])
const store: SessionStore = {
  createSession: () => { throw new Error('not used') },
  getSessions: () => [...sessions.values()],
  getSettings: () => settings,
  getSession: id => sessions.get(id) || null,
  updateSessionTitle: (id, title) => { sessions.get(id)!.title = title },
  updateSessionWorkspace: (id, workspacePath) => { sessions.get(id)!.workspacePath = workspacePath },
  deleteSession: id => { sessions.delete(id); messages.delete(id) },
  getOrCreateBotSession: () => sessions.get('s1')!,
  getMessages: id => [...(messages.get(id) || [])],
  addMessage: message => messages.get(message.sessionId)!.push(message),
  getSessionCompaction: () => null,
  setSessionCompaction: () => {},
  tryUpdateSessionTitleIfDefault: () => false,
  addTokenUsage: () => {}
}

const releases = new Map<string, () => void>()
const started: string[] = []
const optionsSeen = new Map<string, AgentRunOptions>()
const executeAgent = async (options: AgentRunOptions, callbacks: AgentEventCallbacks) => {
  const sessionId = options.sessionId!
  started.push(sessionId)
  optionsSeen.set(sessionId, options)
  await new Promise<void>((resolve, reject) => {
    releases.set(sessionId, resolve)
    options.signal?.addEventListener('abort', () => reject(new AgentAbortedError()), { once: true })
  })
  callbacks.onAssistantMessage?.(`reply:${sessionId}`, [])
  callbacks.onComplete?.()
  return []
}

let nextId = 0
const permissions = new PermissionBroker()
const service = new SessionService({
  store,
  tools: new ToolRegistry(),
  permissions,
  getSkillsPrompt: () => 'skills',
  getMcpStatus: () => [],
  getSystemPromptExtra: async id => `avatar:${id}`,
  executeAgent,
  fetchContextWindow: async () => 32768,
  planAutoCompact: async () => ({
    beforeTokens: 0, afterTokens: 0, compressedCount: 0, keptCount: 0, keptOffset: 0, summary: null
  }),
  completeText: async () => '',
  generateMessageId: () => `m${++nextId}`,
  now: () => 100
})

const events: string[] = []
service.events.subscribe({
  running: (id, running) => events.push(`${id}:running:${running}`),
  aborted: id => events.push(`${id}:aborted`),
  userMessage: (message, source) => events.push(`${message.sessionId}:user:${message.id}:${source}`),
  complete: id => events.push(`${id}:complete`)
})

const first = await service.sendMessage({ sessionId: 's1', message: { text: 'one' }, approveMode: 'auto' })
const second = await service.sendMessage({ sessionId: 's2', message: { text: 'two' }, sourcePrompt: 'bot-source' })
assert.deepEqual(started, ['s1', 's2'], 'different sessions start concurrently')
assert.deepEqual(new Set(service.runningSessionIds()), new Set(['s1', 's2']))
assert.equal(first.userMessage.id, 'm1')
assert.equal(second.userMessage.id, 'm2')
assert.equal(optionsSeen.get('s1')?.systemPromptExtra, 'avatar:s1')
assert.equal(optionsSeen.get('s2')?.systemPromptExtra, 'bot-source\n\navatar:s2')
assert.equal(service.getApproveMode('s1'), 'auto')
await assert.rejects(service.sendMessage({ sessionId: 's1', message: { text: 'duplicate' } }), SessionBusyError)

assert.equal(service.abort('s1'), true)
await assert.rejects(first.completion, AgentAbortedError)
assert.equal(service.isRunning('s1'), false)
assert.equal(service.isRunning('s2'), true, 'aborting one session does not affect another')
releases.get('s2')?.()
await second.completion
assert.deepEqual(service.runningSessionIds(), [])
assert.ok(events.includes('s1:aborted'))
assert.ok(events.includes('s1:running:false'))
assert.ok(events.includes('s2:complete'))
assert.ok(events.includes('s1:user:m1:renderer'))
assert.equal(messages.get('s1')?.filter(message => message.role === 'user').length, 1)
assert.equal(messages.get('s2')?.some(message => message.content === 'reply:s2'), true)

const external = await service.sendMessage({ sessionId: 's2', message: { text: 'from bot' }, inputSource: 'external' })
releases.get('s2')?.()
await external.completion
assert.ok(events.includes(`${external.userMessage.sessionId}:user:${external.userMessage.id}:external`))

const deleting = await service.sendMessage({ sessionId: 's1', message: { text: 'delete while running' } })
void deleting.completion.catch(() => {})
await service.deleteSession('s1')
assert.equal(service.getSession('s1'), null, 'deletion waits for the active run to abort before removing persisted state')
assert.equal(service.isRunning('s1'), false)

permissions.dispose()
console.log('Session service concurrency, ownership and event tests passed')
