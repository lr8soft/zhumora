import assert from 'node:assert/strict'
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs'
import { PermissionBroker } from '../src/main/agent/permissionBroker.ts'
import type { BotAgentMessage, BotAgentResult } from '../src/main/bot/contracts.ts'
import {
  splitQQText,
  type QQButtonEvent,
  type QQClient,
  type QQMessage,
  type QQMessageTarget,
  type QQTextStream
} from '../src/main/qq/client.ts'
import {
  isQQPermissionCallbackAuthorized,
  parseQQPermissionCallback,
  qqPermissionCallbackData,
  QQPermissionPresenter,
  type QQPermissionRoute
} from '../src/main/qq/permissionPresenter.ts'
import { QQResponseStream } from '../src/main/qq/responseStream.ts'
import { QQBotService } from '../src/main/qq/service.ts'

class FakeStream implements QQTextStream {
  updates: string[] = []
  completes = 0
  cancelled = false
  failUpdates = false
  async update(text: string): Promise<void> {
    if (this.failUpdates) throw new Error('stream unsupported')
    this.updates.push(text)
  }
  async complete(): Promise<void> { this.completes++ }
  cancel(): void { this.cancelled = true }
}

class FakeQQClient implements QQClient {
  readonly appId: string
  texts: Array<{ target: QQMessageTarget; text: string }> = []
  keyboards: InlineKeyboard[] = []
  streams: FakeStream[] = []
  acks: Array<{ id: string; code?: number }> = []
  failStreams = false
  verified = 0
  stopped = 0
  private ready?: () => void
  private message?: (message: QQMessage) => void | Promise<void>
  private interaction?: (event: QQButtonEvent) => void | Promise<void>

  constructor(appId = 'app-1') { this.appId = appId }
  onReady(handler: () => void): void { this.ready = handler }
  onError(_handler: (error: Error) => void): void {}
  onMessage(handler: (message: QQMessage) => void | Promise<void>): void { this.message = handler }
  onInteraction(handler: (event: QQButtonEvent) => void | Promise<void>): void { this.interaction = handler }
  async verifyCredentials(): Promise<void> { this.verified++ }
  start(signal: AbortSignal): Promise<void> {
    queueMicrotask(() => this.ready?.())
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  stop(): void { this.stopped++ }
  async sendText(target: QQMessageTarget, text: string): Promise<void> { this.texts.push({ target, text }) }
  async sendTextWithKeyboard(target: QQMessageTarget, text: string, keyboard: InlineKeyboard): Promise<void> {
    this.texts.push({ target, text }); this.keyboards.push(keyboard)
  }
  async acknowledgeInteraction(id: string, code?: number): Promise<void> { this.acks.push({ id, code }) }
  openStream(_target: QQMessageTarget): QQTextStream {
    const stream = new FakeStream(); stream.failUpdates = this.failStreams; this.streams.push(stream); return stream
  }
  emitMessage(message: QQMessage): void { void this.message?.(message) }
  emitInteraction(event: QQButtonEvent): void { void this.interaction?.(event) }
}

const c2cTarget: QQMessageTarget = { scope: 'c2c', targetId: 'user-a', msgId: 'msg-1' }
assert.deepEqual(splitQQText('😀😀😀', 2), ['😀😀', '😀'])

const responseClient = new FakeQQClient()
const response = new QQResponseStream(responseClient, c2cTarget)
response.events.reasoning?.('s1', 'a1', 'thinking')
response.events.token?.('s1', 'a1', 'hello')
response.events.toolCall?.('s1', 'a1', {
  id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test"}' }
})
response.events.toolResult?.(
  { id: 'tm1', sessionId: 's1', role: 'tool', content: 'ok', toolCallId: 'tc1', toolName: 'bash', timestamp: 1 },
  'tc1', 'bash', 'ok', false, 1200
)
response.events.assistantEnd?.('s1', 'a1', 'hello world', [])
await response.flush()
assert.ok(responseClient.streams[0].updates.includes('💭 thinking'))
assert.ok(responseClient.streams[0].updates.includes('hello world'))
assert.equal(responseClient.streams[0].completes, 1)
assert.ok(responseClient.texts.some(item => item.text === '🔧 bash: npm test'))
assert.ok(responseClient.texts.some(item => item.text === '✅ 完成 · bash · 1.2s'))

const fallbackClient = new FakeQQClient()
fallbackClient.failStreams = true
const fallbackResponse = new QQResponseStream(fallbackClient, c2cTarget)
fallbackResponse.events.token?.('s1', 'a2', 'partial')
fallbackResponse.events.assistantEnd?.('s1', 'a2', 'final answer', [])
await fallbackResponse.flush()
assert.ok(fallbackClient.texts.some(item => item.text === 'final answer'))

const groupClient = new FakeQQClient()
const groupResponse = new QQResponseStream(groupClient, { scope: 'group', targetId: 'group-a', msgId: 'msg-2' })
groupResponse.events.reasoning?.('s1', 'a3', 'thinking')
groupResponse.events.reasoning?.('s1', 'a3', ' more')
groupResponse.events.assistantEnd?.('s1', 'a3', 'group answer', [])
await groupResponse.flush()
assert.equal(groupClient.texts.filter(item => item.text === '💭 思考中…').length, 1)
assert.ok(groupClient.texts.some(item => item.text === 'group answer'))

const callbackData = qqPermissionCallbackData('perm-1', true)
assert.equal(callbackData, 'zhp:perm-1:1')
assert.deepEqual(parseQQPermissionCallback(callbackData), { permissionId: 'perm-1', allowed: true })
assert.equal(parseQQPermissionCallback('bad'), null)
const route: QQPermissionRoute = { permissionId: 'perm-1', senderId: 'user-a', scope: 'c2c', targetId: 'user-a' }
const interaction = qqInteraction('interaction-1', callbackData)
assert.equal(isQQPermissionCallbackAuthorized(route, interaction, ['user-a']), true)
assert.equal(isQQPermissionCallbackAuthorized({ ...route, senderId: 'other' }, interaction, ['user-a']), false)

let registered: QQPermissionRoute | undefined
const presenter = new QQPermissionPresenter(
  responseClient,
  c2cTarget,
  'user-a',
  value => { registered = value },
  () => { registered = undefined }
)
const permissionRequest = { id: 'perm-2', sessionId: 's1', toolName: 'write', level: 'normal' as const, args: { path: 'a.txt', token: 'secret' } }
await presenter.present(permissionRequest)
assert.equal(registered?.permissionId, 'perm-2')
assert.equal(responseClient.keyboards.length, 1)
assert.doesNotMatch(responseClient.texts.at(-1)?.text || '', /secret/)
presenter.resolve(permissionRequest, 'approved')
assert.equal(registered, undefined)

const serviceClient = new FakeQQClient()
const handled: BotAgentMessage[] = []
const permissions = new PermissionBroker()
let permissionDecision: boolean | undefined
const fakeAgent = {
  async handle(message: BotAgentMessage): Promise<BotAgentResult> {
    handled.push(message)
    assert.equal(message.onSessionReady?.('qq-session'), true)
    if (message.text === 'needs permission') {
      permissionDecision = await permissions.request({
        sessionId: 'qq-session', toolName: 'write', args: { path: 'file.txt' }, level: 'normal'
      }, message.permissionPresenters, 1000)
    }
    message.events.token?.('qq-session', 'assistant-1', 'hi')
    message.events.assistantEnd?.('qq-session', 'assistant-1', 'hi there', [])
    return { sessionId: 'qq-session' }
  }
}
const service = new QQBotService(fakeAgent as any, permissions, { clientFactory: () => serviceClient })
await service.configure({
  enabled: true,
  appId: 'app-1',
  appSecret: 'secret',
  allowedUserIds: ['user-a'],
  approveMode: 'auto'
})

serviceClient.emitMessage(qqMessage('/id', 'unknown'))
await eventually(() => serviceClient.texts.some(item => item.text.includes('unknown')))
serviceClient.emitMessage(qqMessage('ignored', 'unknown'))
await new Promise(resolve => setTimeout(resolve, 5))
assert.equal(handled.length, 0)
serviceClient.emitMessage(qqMessage('hello', 'user-a'))
await eventually(() => handled.length === 1)
assert.equal(handled[0].channel, 'qq')
assert.equal(handled[0].conversationId, 'c2c:user-a')
assert.equal(handled[0].approveMode, 'auto')
assert.equal(handled[0].accountId, 'app-1')
await eventually(() => serviceClient.streams[0]?.completes === 1)

serviceClient.emitMessage(qqMessage('needs permission', 'user-a'))
await eventually(() => serviceClient.keyboards.length === 1)
const permissionData = serviceClient.keyboards[0].content.rows[0].buttons[0].action.data
serviceClient.emitInteraction(qqInteraction('interaction-service', permissionData))
await eventually(() => permissionDecision === true)
assert.deepEqual(serviceClient.acks.at(-1), { id: 'interaction-service', code: 0 })
await service.stop()
assert.ok(serviceClient.stopped > 0)

const testClient = new FakeQQClient('tested-app')
const testService = new QQBotService(fakeAgent as any, permissions, { clientFactory: () => testClient })
assert.deepEqual(await testService.test({
  enabled: false, appId: 'tested-app', appSecret: 'secret', allowedUserIds: [], approveMode: 'manual'
}), { name: 'QQ Bot tested-app' })
assert.equal(testClient.verified, 1)
await assert.rejects(() => testService.test({
  enabled: false, appId: '', appSecret: '', allowedUserIds: [], approveMode: 'manual'
}), /AppID is required/)

permissions.dispose()
console.log('QQ Bot adapter tests passed')

function qqMessage(content: string, senderId: string): QQMessage {
  return {
    rawEventType: 'C2C_MESSAGE_CREATE',
    kind: 'c2c',
    senderId,
    content,
    messageId: `msg-${content}`,
    timestamp: new Date().toISOString(),
    replyTarget: { scope: 'c2c', targetId: senderId, msgId: `msg-${content}` },
    raw: { id: `msg-${content}`, content, timestamp: new Date().toISOString(), author: { user_openid: senderId } }
  }
}

function qqInteraction(id: string, buttonData: string): QQButtonEvent {
  return {
    id,
    type: 11,
    version: 1,
    user_openid: 'user-a',
    data: { type: 1, resolved: { button_data: buttonData } }
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail('condition was not reached')
}
