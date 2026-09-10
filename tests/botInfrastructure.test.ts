import assert from 'node:assert/strict'
import { AgentAbortedError, type AppSettings } from '../src/shared/types.ts'
import type { BotPlatformRuntime } from '../src/main/bot/contracts.ts'
import { BotPlatformManager, defineBotPlatform } from '../src/main/bot/platformManager.ts'
import { BotMessageQueue } from '../src/main/bot/messageQueue.ts'

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

// The transport queue preserves per-conversation order without owning session state.
const queue = new BotMessageQueue()
let releaseFirst!: () => void
const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
const starts: string[] = []
const first = queue.enqueue('same', async () => {
  starts.push('first')
  await firstGate
})
const second = queue.enqueue('same', async () => { starts.push('second') })
const parallel = queue.enqueue('other', async () => { starts.push('parallel') })
await tick()
assert.deepEqual(starts, ['first', 'parallel'])
releaseFirst()
await Promise.all([first, second, parallel])
assert.deepEqual(starts, ['first', 'parallel', 'second'])

let abortReady!: () => void
const readyToAbort = new Promise<void>(resolve => { abortReady = resolve })
const aborting = queue.enqueue('abort-me', signal => new Promise<void>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new AgentAbortedError()), { once: true })
  abortReady()
}))
await readyToAbort
assert.equal(queue.abortConversation('abort-me'), true)
await assert.rejects(aborting, AgentAbortedError)
assert.equal(queue.abortConversation('missing'), false)

const stopping = new BotMessageQueue()
let stopReady!: () => void
const readyToStop = new Promise<void>(resolve => { stopReady = resolve })
const stoppedRuns: string[] = []
const activeBeforeStop = stopping.enqueue('queued-stop', signal => new Promise<void>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new AgentAbortedError()), { once: true })
  stoppedRuns.push('active')
  stopReady()
}))
void activeBeforeStop.catch(() => {})
const queuedBeforeStop = stopping.enqueue('queued-stop', async () => { stoppedRuns.push('queued') })
await readyToStop
await stopping.stop()
await Promise.allSettled([activeBeforeStop, queuedBeforeStop])
assert.equal(stoppedRuns.includes('queued'), false, 'stop discards work that has not started')

interface FakeConfig { enabled: boolean; value: string }
class FakeRuntime implements BotPlatformRuntime {
  readonly channel = 'fake'
  stops = 0
  configured: FakeConfig[] = []
  async stop(): Promise<void> { this.stops++ }
  async configure(config: FakeConfig): Promise<void> { this.configured.push(config) }
}

const settings = (config: FakeConfig) => ({ fake: config }) as unknown as AppSettings
const runtime = new FakeRuntime()
const manager = new BotPlatformManager([
  defineBotPlatform({
    service: runtime,
    selectConfig: input => (input as unknown as { fake: FakeConfig }).fake,
    normalizeConfig: input => {
      const raw = input as Partial<FakeConfig>
      return { enabled: raw.enabled === true, value: typeof raw.value === 'string' ? raw.value : '' }
    },
    equivalentConfig: (left, right) => left.enabled === right.enabled && left.value === right.value,
    test: async config => ({ name: config.value })
  })
])

await manager.configureAll(settings({ enabled: true, value: 'one' }))
assert.equal(runtime.configured.length, 1)
await manager.applySettings(settings({ enabled: true, value: 'one' }), settings({ enabled: true, value: 'one' }))
assert.equal(runtime.configured.length, 1, 'semantic equality avoids reconnect')
await manager.applySettings(settings({ enabled: true, value: 'two' }), settings({ enabled: true, value: 'one' }))
assert.equal(runtime.configured.at(-1)?.value, 'two')
assert.deepEqual(await manager.test('fake', { enabled: true, value: 'checked' }), { name: 'checked' })
await assert.rejects(() => manager.test('missing', {}), /Unknown Bot platform/)
await manager.stopAll()
assert.equal(runtime.stops, 1)

console.log('Bot message queue and platform manager tests passed')
