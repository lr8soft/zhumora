import assert from 'node:assert/strict'
import { AgentAbortedError, type AppSettings } from '../src/shared/types.ts'
import type { AgentEventSink } from '../src/main/agent/persistedCallbacks.ts'
import type { BotActivity, BotPlatformRuntime } from '../src/main/bot/contracts.ts'
import { BotPlatformManager, defineBotPlatform } from '../src/main/bot/platformManager.ts'
import { BotRunCoordinator } from '../src/main/bot/runCoordinator.ts'

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

// Per-conversation FIFO ordering, cross-conversation concurrency and lifecycle.
const cancelled: string[] = []
const coordinator = new BotRunCoordinator({ cancelSession: sessionId => cancelled.push(sessionId) })
const activities: string[] = []
coordinator.setActivityListener(activity => {
  activities.push(`${activity.sessionId}:${activity.state}`)
})

let releaseFirst!: () => void
const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
const starts: string[] = []
const first = coordinator.enqueue('same', async run => {
  assert.equal(run.onSessionReady('s1'), true)
  starts.push('first')
  await firstGate
})
const second = coordinator.enqueue('same', async run => {
  assert.equal(run.onSessionReady('s2'), true)
  starts.push('second')
})
const parallel = coordinator.enqueue('other', async run => {
  assert.equal(run.onSessionReady('s3'), true)
  starts.push('parallel')
})
await tick()
assert.deepEqual(starts, ['first', 'parallel'])
releaseFirst()
await Promise.all([first, second, parallel])
assert.deepEqual(starts, ['first', 'parallel', 'second'])
assert.ok(activities.includes('s1:complete'))
assert.ok(activities.includes('s2:complete'))
assert.ok(activities.includes('s3:complete'))

let abortStarted!: () => void
const abortReady = new Promise<void>(resolve => { abortStarted = resolve })
const aborting = coordinator.enqueue('abort-me', run => new Promise<void>((_resolve, reject) => {
  assert.equal(run.onSessionReady('s4'), true)
  run.signal.addEventListener('abort', () => reject(new AgentAbortedError()), { once: true })
  abortStarted()
}))
await abortReady
assert.equal(coordinator.abortSession('s4'), true)
await assert.rejects(aborting, AgentAbortedError)
assert.ok(cancelled.includes('s4'))
assert.ok(activities.includes('s4:aborted'))
assert.equal(coordinator.abortSession('missing'), false)

const stoppedRuns: string[] = []
const stopping = new BotRunCoordinator({ cancelSession: sessionId => stoppedRuns.push(`cancel:${sessionId}`) })
let stopReady!: () => void
const readyToStop = new Promise<void>(resolve => { stopReady = resolve })
const activeBeforeStop = stopping.enqueue('queued-stop', run => new Promise<void>((_resolve, reject) => {
  assert.equal(run.onSessionReady('s5'), true)
  run.signal.addEventListener('abort', () => reject(new AgentAbortedError()), { once: true })
  stoppedRuns.push('active')
  stopReady()
}))
void activeBeforeStop.catch(() => {})
const queuedBeforeStop = stopping.enqueue('queued-stop', async () => { stoppedRuns.push('queued') })
await readyToStop
await stopping.stop()
await Promise.allSettled([activeBeforeStop, queuedBeforeStop])
assert.ok(stoppedRuns.includes('cancel:s5'))
assert.equal(stoppedRuns.includes('queued'), false, 'stop discards work that has not started')

// Platform registration keeps config knowledge at the composition boundary.
interface FakeConfig { enabled: boolean; value: string }
class FakeRuntime implements BotPlatformRuntime {
  readonly channel = 'fake'
  sink?: AgentEventSink
  listener?: (activity: BotActivity) => boolean | void
  stops = 0
  aborts: string[] = []
  configured: FakeConfig[] = []
  setAgentEventSink(sink: AgentEventSink): void { this.sink = sink }
  setActivityListener(listener: (activity: BotActivity) => boolean | void): void { this.listener = listener }
  abortSession(sessionId: string): boolean { this.aborts.push(sessionId); return sessionId === 'owned' }
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
await manager.applySettings(
  settings({ enabled: true, value: 'one' }),
  settings({ enabled: true, value: 'one' })
)
assert.equal(runtime.configured.length, 1, 'semantic equality avoids reconnect')
await manager.applySettings(
  settings({ enabled: true, value: 'two' }),
  settings({ enabled: true, value: 'one' })
)
assert.equal(runtime.configured.at(-1)?.value, 'two')
assert.deepEqual(await manager.test('fake', { enabled: true, value: 'checked' }), { name: 'checked' })
await assert.rejects(() => manager.test('missing', {}), /Unknown Bot platform/)

const sink: AgentEventSink = {}
manager.setAgentEventSink(sink)
manager.setActivityListener(() => {})
assert.equal(runtime.sink, sink)
assert.equal(manager.abortSession('owned'), true)
assert.equal(manager.abortSession('foreign'), false)
await manager.stopAll()
assert.equal(runtime.stops, 1)

console.log('Bot run coordinator and platform manager tests passed')
