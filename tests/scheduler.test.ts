import assert from 'node:assert/strict'
import {
  AUTO_DISABLE_ERROR_THRESHOLD,
  CATCHUP_WINDOW_MS,
  DEFAULT_HEARTBEAT_CHECKLIST,
  HEARTBEAT_OK,
  buildHeartbeatPrompt,
  computeNextRun,
  isHeartbeatSilent,
  isTimeOfDay,
  isWithinQuietHours,
  normalizeQuietHours,
  quietEndAfter,
  normalizeSchedule,
  previewSchedule,
  resolveMissedRun,
  validateJobInput,
  type Schedule
} from '../src/shared/scheduled.ts'

let passed = 0
function check(name: string, fn: () => void): void {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const at = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

console.log('isTimeOfDay')
check('合法时间', () => {
  assert.ok(isTimeOfDay('00:00'))
  assert.ok(isTimeOfDay('07:30'))
  assert.ok(isTimeOfDay('23:59'))
})
check('非法时间拒绝', () => {
  assert.ok(!isTimeOfDay('24:00'))
  assert.ok(!isTimeOfDay('7:30'))
  assert.ok(!isTimeOfDay('07:60'))
  assert.ok(!isTimeOfDay('abc'))
  assert.ok(!isTimeOfDay(730))
})

console.log('normalizeSchedule')
check('daily/weekly/interval 归一化', () => {
  assert.deepEqual(normalizeSchedule({ kind: 'daily', time: '07:00' }), { kind: 'daily', time: '07:00' })
  assert.deepEqual(normalizeSchedule({ kind: 'weekly', weekday: 1, time: '09:00' }), { kind: 'weekly', weekday: 1, time: '09:00' })
  assert.deepEqual(normalizeSchedule({ kind: 'interval', minutes: 30 }), { kind: 'interval', minutes: 30 })
})
check('非法值拒绝', () => {
  assert.equal(normalizeSchedule(null), null)
  assert.equal(normalizeSchedule({ kind: 'daily' }), null)
  assert.equal(normalizeSchedule({ kind: 'daily', time: '24:00' }), null)
  assert.equal(normalizeSchedule({ kind: 'weekly', weekday: 7, time: '09:00' }), null)
  assert.equal(normalizeSchedule({ kind: 'weekly', weekday: -1, time: '09:00' }), null)
  assert.equal(normalizeSchedule({ kind: 'interval', minutes: 0 }), null)
  assert.equal(normalizeSchedule({ kind: 'interval', minutes: 1.5 }), null)
  assert.equal(normalizeSchedule({ kind: 'hourly' }), null)
})

console.log('computeNextRun')
check('daily：今天未到点 → 今天；已过点 → 明天', () => {
  const schedule: Schedule = { kind: 'daily', time: '07:00' }
  assert.equal(computeNextRun(schedule, at(2026, 9, 10, 6, 59)), at(2026, 9, 10, 7, 0))
  assert.equal(computeNextRun(schedule, at(2026, 9, 10, 7, 0)), at(2026, 9, 11, 7, 0))
  assert.equal(computeNextRun(schedule, at(2026, 9, 10, 7, 1)), at(2026, 9, 11, 7, 0))
  assert.equal(computeNextRun(schedule, at(2026, 9, 10, 23, 59)), at(2026, 9, 11, 7, 0))
})
check('daily：跨月', () => {
  const schedule: Schedule = { kind: 'daily', time: '07:00' }
  assert.equal(computeNextRun(schedule, at(2026, 9, 30, 8, 0)), at(2026, 10, 1, 7, 0))
})
check('weekly：目标星期未到；严格晚于语义', () => {
  // 2026-09-10 是周四
  const schedule: Schedule = { kind: 'weekly', weekday: 1, time: '09:00' } // 周一
  assert.equal(computeNextRun(schedule, at(2026, 9, 10, 6, 0)), at(2026, 9, 14, 9, 0))
  const today: Schedule = { kind: 'weekly', weekday: 4, time: '10:00' } // 今天周四 10:00
  assert.equal(computeNextRun(today, at(2026, 9, 10, 9, 0)), at(2026, 9, 10, 10, 0))
  assert.equal(computeNextRun(today, at(2026, 9, 10, 10, 0)), at(2026, 9, 17, 10, 0))
})
check('interval：严格 after + 间隔', () => {
  const schedule: Schedule = { kind: 'interval', minutes: 30 }
  assert.equal(computeNextRun(schedule, at(2026, 9, 10, 7, 0)), at(2026, 9, 10, 7, 30))
})

console.log('resolveMissedRun')
check('窗口内 catchUp → 补跑一次并排到下个周期', () => {
  const r = resolveMissedRun({ kind: 'daily', time: '07:00' }, at(2026, 9, 10, 7, 0), at(2026, 9, 10, 7, 30), true)
  assert.equal(r.action, 'run')
  assert.equal(r.nextRunAt, at(2026, 9, 11, 7, 0))
})
check('窗口内但不允许 catchUp → 跳过', () => {
  const r = resolveMissedRun({ kind: 'daily', time: '07:00' }, at(2026, 9, 10, 7, 0), at(2026, 9, 10, 7, 30), false)
  assert.equal(r.action, 'skip')
  assert.equal(r.nextRunAt, at(2026, 9, 11, 7, 0))
})
check('超过补跑窗口 → 跳过', () => {
  const r = resolveMissedRun({ kind: 'daily', time: '07:00' }, at(2026, 9, 10, 7, 0), at(2026, 9, 10, 9, 0) + 1, true)
  assert.equal(r.action, 'skip')
})
check('窗口边界（恰好 CATCHUP_WINDOW_MS）→ 补跑', () => {
  const planned = at(2026, 9, 10, 7, 0)
  const r = resolveMissedRun({ kind: 'daily', time: '07:00' }, planned, planned + CATCHUP_WINDOW_MS, true)
  assert.equal(r.action, 'run')
})

console.log('isWithinQuietHours')
check('同日内时段', () => {
  const q = { start: '09:00', end: '18:00' }
  assert.ok(isWithinQuietHours(q, at(2026, 9, 10, 9, 0)))
  assert.ok(!isWithinQuietHours(q, at(2026, 9, 10, 18, 0)))
  assert.ok(!isWithinQuietHours(q, at(2026, 9, 10, 8, 59)))
})
check('跨午夜时段', () => {
  const q = { start: '22:00', end: '08:00' }
  assert.ok(isWithinQuietHours(q, at(2026, 9, 10, 23, 0)))
  assert.ok(isWithinQuietHours(q, at(2026, 9, 10, 7, 59)))
  assert.ok(!isWithinQuietHours(q, at(2026, 9, 10, 8, 0)))
  assert.ok(!isWithinQuietHours(q, at(2026, 9, 10, 12, 0)))
})
check('start==end 视为未启用；null 返回 false', () => {
  assert.ok(!isWithinQuietHours({ start: '09:00', end: '09:00' }, at(2026, 9, 10, 9, 30)))
  assert.ok(!isWithinQuietHours(null, at(2026, 9, 10, 9, 30)))
})

console.log('quietEndAfter')
check('不在 quiet hours → null', () => {
  assert.equal(quietEndAfter({ start: '22:00', end: '08:00' }, at(2026, 9, 10, 12, 0)), null)
  assert.equal(quietEndAfter(null, at(2026, 9, 10, 23, 0)), null)
})
check('跨午夜：晚间段（23:00）延到次日 08:00', () => {
  const q = { start: '22:00', end: '08:00' }
  assert.equal(quietEndAfter(q, at(2026, 9, 10, 23, 0)), at(2026, 9, 11, 8, 0))
})
check('跨午夜：凌晨段（07:00）延到当日 08:00', () => {
  const q = { start: '22:00', end: '08:00' }
  assert.equal(quietEndAfter(q, at(2026, 9, 10, 7, 0)), at(2026, 9, 10, 8, 0))
})
check('同日内：10:00 落在 09:00-18:00 → 延到 18:00', () => {
  const q = { start: '09:00', end: '18:00' }
  assert.equal(quietEndAfter(q, at(2026, 9, 10, 10, 0)), at(2026, 9, 10, 18, 0))
})
check('normalizeQuietHours 校验', () => {
  assert.deepEqual(normalizeQuietHours({ start: '22:00', end: '08:00' }), { start: '22:00', end: '08:00' })
  assert.equal(normalizeQuietHours({ start: '22:00', end: 'bad' }), null)
  assert.equal(normalizeQuietHours('x'), null)
})

console.log('validateJobInput')
check('合法 cron 任务通过', () => {
  assert.equal(validateJobInput({
    name: '晨报', kind: 'cron', schedule: { kind: 'daily', time: '07:00' }, prompt: '汇总日历'
  }), null)
})
check('heartbeat 任务可无 prompt', () => {
  assert.equal(validateJobInput({
    name: 'hb', kind: 'heartbeat', schedule: { kind: 'interval', minutes: 30 }
  }), null)
})
check('非法输入拒绝', () => {
  assert.ok(validateJobInput(null))
  assert.ok(validateJobInput({ name: '', kind: 'cron', schedule: { kind: 'daily', time: '07:00' }, prompt: 'x' }))
  assert.ok(validateJobInput({ name: 'x', kind: 'cron', schedule: { kind: 'daily', time: '07:00' } }))
  assert.ok(validateJobInput({ name: 'x', kind: 'cron', schedule: { kind: 'daily', time: 'bad' }, prompt: 'x' }))
  assert.ok(validateJobInput({ name: 'x', kind: 'weird', schedule: { kind: 'daily', time: '07:00' }, prompt: 'x' }))
  assert.ok(validateJobInput({ name: 'x', kind: 'cron', schedule: { kind: 'daily', time: '07:00' }, prompt: 'x', maxRounds: -1 }))
  assert.ok(validateJobInput({ name: 'x', kind: 'cron', schedule: { kind: 'daily', time: '07:00' }, prompt: 'x', quietHours: { start: 'a', end: 'b' } }))
})

console.log('buildHeartbeatPrompt / isHeartbeatSilent')
check('心跳 prompt 注入自定义清单', () => {
  const p = buildHeartbeatPrompt('检查收件箱', at(2026, 9, 10, 7, 0))
  assert.ok(p.includes('检查收件箱'))
  assert.ok(p.includes(HEARTBEAT_OK))
})
check('空清单回退内置清单', () => {
  const p = buildHeartbeatPrompt(null, at(2026, 9, 10, 7, 0))
  assert.ok(p.includes(DEFAULT_HEARTBEAT_CHECKLIST))
})
check('静默判定：首行 OK', () => {
  assert.ok(isHeartbeatSilent(HEARTBEAT_OK))
  assert.ok(isHeartbeatSilent(HEARTBEAT_OK + '.'))
  assert.ok(isHeartbeatSilent(`\n\n${HEARTBEAT_OK}`))
})
check('静默判定：有实质内容不算', () => {
  assert.ok(!isHeartbeatSilent(`${HEARTBEAT_OK} 但邮件里有一条紧急事项`))
  assert.ok(!isHeartbeatSilent(`没事，${HEARTBEAT_OK}`))
  assert.ok(!isHeartbeatSilent(null))
  assert.ok(!isHeartbeatSilent(''))
  assert.ok(!isHeartbeatSilent('HEARTBEAT_OKAY 额外内容'))
})

console.log('previewSchedule')
check('连续 3 次 daily', () => {
  assert.deepEqual(
    previewSchedule({ kind: 'daily', time: '07:00' }, at(2026, 9, 10, 6, 0), 3),
    [at(2026, 9, 10, 7, 0), at(2026, 9, 11, 7, 0), at(2026, 9, 12, 7, 0)]
  )
})
check('interval 连续推进', () => {
  const base = at(2026, 9, 10, 7, 0)
  assert.deepEqual(previewSchedule({ kind: 'interval', minutes: 15 }, base, 2), [base + 900_000, base + 1_800_000])
})

console.log('常量')
check('自动停用阈值与补跑窗口', () => {
  assert.equal(AUTO_DISABLE_ERROR_THRESHOLD, 5)
  assert.equal(CATCHUP_WINDOW_MS, 60 * 60_000)
})

console.log(`\n✅ ${passed} passed, 0 failed`)
