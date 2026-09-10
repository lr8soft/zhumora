import assert from 'node:assert/strict'
import { SchedulerService } from '../src/main/scheduler/index.ts'
import type { AppSettings } from '../src/shared/types.ts'
import type { ScheduledJob, ScheduledRunStatus } from '../src/shared/scheduled.ts'
import { computeNextRun } from '../src/shared/scheduled.ts'
import type { AgentEventSink } from '../src/main/agent/persistedCallbacks.ts'

// ============================================================
// SchedulerService 集成测试：假 store + 假 agent + 注入时钟，验证
// 触发 / catch-up / quiet hours / skip-busy / silent / 错误计数 全链路。
// 时钟固定为 NOW：到点任务在 start() 内同步 fire；未来任务的真实
// setTimeout 在测试期间不会触发，stop() 时清理。
// ============================================================

const at = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

const NOW = at(2026, 9, 10, 12, 0) // 周四中午 12:00
const SETTINGS = { workspacePath: '/tmp/nonexistent' } as unknown as AppSettings
const permissions = { cancelSession: () => {} }
const tick = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

class FakeStore {
  jobs: ScheduledJob[]
  runs: { id: string; jobId: string; status: ScheduledRunStatus; summary: string | null; error: string | null }[] = []
  constructor(seed: ScheduledJob[]) { this.jobs = seed }
  getScheduledJobs(): ScheduledJob[] { return this.jobs.map(j => ({ ...j })) }
  getScheduledJob(id: string): ScheduledJob | null {
    const j = this.jobs.find(x => x.id === id)
    return j ? { ...j } : null
  }
  updateScheduledJob(id: string, patch: Record<string, unknown>): void {
    const j = this.jobs.find(x => x.id === id)
    if (j) Object.assign(j, patch)
  }
  setJobSession(id: string, sessionId: string): void {
    const j = this.jobs.find(x => x.id === id)
    if (j) j.sessionId = sessionId
  }
  recordJobSuccess(id: string): void {
    const j = this.jobs.find(x => x.id === id)
    if (j) j.consecutiveErrors = 0
  }
  recordJobError(id: string, threshold: number): number {
    const j = this.jobs.find(x => x.id === id)
    if (j) {
      j.consecutiveErrors++
      if (j.consecutiveErrors >= threshold) j.enabled = false
    }
    return j?.consecutiveErrors ?? 0
  }
  insertScheduledRun(id: string, jobId: string, _startedAt: number, status: ScheduledRunStatus): void {
    this.runs.push({ id, jobId, status, summary: null, error: null })
  }
  finishScheduledRun(id: string, status: ScheduledRunStatus, extra?: { summary?: string | null; error?: string | null }): void {
    const r = this.runs.find(x => x.id === id)
    if (r) { r.status = status; r.summary = extra?.summary ?? null; r.error = extra?.error ?? null }
  }
  getSettings(): AppSettings { return SETTINGS }
}

function makeFakeAgent(replyFor: (conversationId: string) => string, calls: string[]) {
  return {
    async handle(message: { conversationId: string; onSessionReady?: (id: string) => boolean | void; events: AgentEventSink }): Promise<{ sessionId: string }> {
      calls.push(message.conversationId)
      const sessionId = `sess-${message.conversationId}`
      if (message.onSessionReady && message.onSessionReady(sessionId) === false) {
        throw new Error('This bot conversation already has a running Agent.')
      }
      const reply = replyFor(message.conversationId)
      if (reply === 'throw') throw new Error('LLM exploded')
      message.events.complete?.(sessionId, 'm1', reply)
      return { sessionId }
    }
  }
}

const job = (id: string, over: Partial<ScheduledJob>): ScheduledJob => ({
  id, name: id, kind: 'cron', schedule: { kind: 'daily', time: '12:00' }, prompt: 'do it',
  sessionId: null, enabled: true, approveMode: 'auto', providerId: null, maxRounds: null,
  quietHours: null, catchUp: true, timeoutMs: 1800000, consecutiveErrors: 0,
  nextRunAt: NOW, createdAt: NOW, updatedAt: NOW, ...over
})

let passed = 0
function check(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${name}`) }

// ---------- 场景 1：到点立即触发 / 未来不触发 / 关机错过不补跑 ----------
{
  console.log('触发 / catch-up')
  const future = job('future', { nextRunAt: NOW + 3600_000 })
  const due = job('due', { nextRunAt: NOW - 1000 })
  const oldMissed = job('old-missed', { nextRunAt: NOW - 2 * 3600_000 })
  const store = new FakeStore([future, due, oldMissed])
  const calls: string[] = []
  const svc = new SchedulerService({ store, agent: makeFakeAgent(() => 'done', calls) as never, permissions, now: () => NOW })
  svc.start()
  await tick(30)
  check('准点任务被触发', () => assert.deepEqual(calls, ['due']))
  check('未来任务未被触发', () => assert.ok(!calls.includes('future')))
  check('关机错过的任务未补跑，只重排到未来', () => {
    assert.ok(!calls.includes('old-missed'))
    assert.ok(store.jobs.find(j => j.id === 'old-missed')!.nextRunAt > NOW)
  })
  check('运行记录落库（due → ok）', () => assert.equal(store.runs.find(x => x.jobId === 'due')?.status, 'ok'))
  await svc.stop()
}

// ---------- 场景 2：sleep 恢复补跑 ----------
{
  console.log('sleep 恢复补跑')
  const sleepMissed = job('sleep-missed', { nextRunAt: NOW - 10 * 60_000, catchUp: true })
  const noCatch = job('no-catch', { nextRunAt: NOW - 10 * 60_000, catchUp: false })
  const store = new FakeStore([sleepMissed, noCatch])
  const calls: string[] = []
  const svc = new SchedulerService({ store, agent: makeFakeAgent(() => 'ok', calls) as never, permissions, now: () => NOW })
  svc.start()
  await tick(20)
  check('app 启动时 10 分钟错过不补跑', () => assert.deepEqual(calls, []))
  // 重新排回到期，模拟 resume（允许补跑）
  for (const id of ['sleep-missed', 'no-catch']) store.jobs.find(j => j.id === id)!.nextRunAt = NOW - 10 * 60_000
  svc.reconcile(true)
  await tick(20)
  check('resume 后 catchUp 任务补跑一次', () => assert.ok(calls.includes('sleep-missed')))
  check('resume 后非 catchUp 任务仍跳过', () => assert.ok(!calls.includes('no-catch')))
  await svc.stop()
}

// ---------- 场景 3：quiet hours 延迟 + runNow 绕过 ----------
{
  console.log('quiet hours')
  const q = job('quiet', { nextRunAt: NOW, quietHours: { start: '09:00', end: '18:00' } })
  const store = new FakeStore([q])
  const calls: string[] = []
  const svc = new SchedulerService({ store, agent: makeFakeAgent(() => 'nope', calls) as never, permissions, now: () => NOW })
  svc.start()
  await tick(20)
  check('quiet 时段内不触发', () => assert.deepEqual(calls, []))
  check('nextRunAt 被延到 18:00', () => assert.equal(store.jobs.find(x => x.id === 'quiet')!.nextRunAt, at(2026, 9, 10, 18, 0)))
  const res = svc.runNow('quiet')
  check('runNow 返回 ok', () => assert.equal(res.ok, true))
  await tick(20)
  check('runNow 绕过 quiet hours 执行', () => assert.ok(calls.includes('quiet')))
  await svc.stop()
}

// ---------- 场景 4：heartbeat 静默 ----------
{
  console.log('heartbeat 静默')
  const hb = job('hb', { kind: 'heartbeat', prompt: null, nextRunAt: NOW - 1000, schedule: { kind: 'interval', minutes: 30 } })
  const store = new FakeStore([hb])
  const calls: string[] = []
  const svc = new SchedulerService({ store, agent: makeFakeAgent(() => 'HEARTBEAT_OK', calls) as never, permissions, now: () => NOW })
  svc.start()
  await tick(30)
  check('心跳静默 → status=silent', () => assert.equal(store.runs.find(x => x.jobId === 'hb')?.status, 'silent'))
  check('心跳会话已绑定', () => assert.equal(store.jobs.find(j => j.id === 'hb')!.sessionId, 'sess-hb'))
  await svc.stop()
}

// ---------- 场景 5：skip-busy（会话已被占用，如用户在 UI 手动运行同一会话）----------
{
  console.log('skip-busy')
  const busy = job('busy', { sessionId: 'sess-x', nextRunAt: NOW - 1000 })
  const store = new FakeStore([busy])
  const calls: string[] = []
  const svc = new SchedulerService({ store, agent: makeFakeAgent(() => 'should-not-run', calls) as never, permissions, now: () => NOW })
  // 模拟 IPC 注入的 busy 判定：sess-x 正在被 UI 手动运行
  svc.setBusyCheck(sid => sid === 'sess-x')
  svc.start()
  await tick(30)
  check('会话忙时不触发', () => assert.deepEqual(calls, []))
  check('记为 skipped', () => assert.equal(store.runs.find(x => x.jobId === 'busy')?.status, 'skipped'))
  check('skipped 后 nextRunAt 已重排到未来', () => assert.ok(store.jobs.find(j => j.id === 'busy')!.nextRunAt > NOW))
  await svc.stop()
}

// ---------- 场景 6：错误计数 + 自动停用 ----------
{
  console.log('错误计数 / 自动停用')
  const failing = job('failing', { nextRunAt: NOW - 1000, schedule: { kind: 'daily', time: '23:59' } })
  const store = new FakeStore([failing])
  const calls: string[] = []
  const svc = new SchedulerService({ store, agent: makeFakeAgent(() => 'throw', calls) as never, permissions, now: () => NOW })
  svc.start()
  await tick(30)
  check('第一次失败 → consecutiveErrors=1，仍启用', () => {
    const j = store.jobs.find(x => x.id === 'failing')!
    assert.equal(j.consecutiveErrors, 1)
    assert.equal(j.enabled, true)
  })
  await svc.stop()
  // 连续触发到第 5 次
  for (let i = 0; i < 4; i++) {
    const j = store.jobs.find(x => x.id === 'failing')!
    if (!j.enabled) break
    j.nextRunAt = NOW - 1000
    svc.start()
    await tick(30)
    await svc.stop()
  }
  check('连续 5 次失败 → 自动停用', () => {
    const j = store.jobs.find(x => x.id === 'failing')!
    assert.equal(j.consecutiveErrors, 5)
    assert.equal(j.enabled, false)
  })
}

// ---------- 场景 7：触发后重排到下一个周期 ----------
{
  console.log('重排')
  const daily = job('daily', { nextRunAt: NOW - 1000, schedule: { kind: 'daily', time: '07:00' } })
  const store = new FakeStore([daily])
  const calls: string[] = []
  const svc = new SchedulerService({ store, agent: makeFakeAgent(() => 'x', calls) as never, permissions, now: () => NOW })
  svc.start()
  await tick(20)
  check('触发后 nextRunAt 排到次日 07:00', () => {
    const j = store.jobs.find(x => x.id === 'daily')!
    assert.equal(j.nextRunAt, computeNextRun({ kind: 'daily', time: '07:00' }, NOW))
  })
  await svc.stop()
}

console.log(`\n✅ ${passed} passed, 0 failed`)
