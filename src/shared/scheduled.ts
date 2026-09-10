import type { AutoApproveMode } from './types'

// ============================================================
// 定时任务（scheduler channel）跨进程契约与纯函数。
// 不依赖 Electron / 数据库；IPC 边界用它做运行时校验，
// main 的 SchedulerService 用它计算触发时间。
// ============================================================

/** 固定 jobId：周期性"心跳"检查任务（对应 OpenClaw heartbeat 语义） */
export const HEARTBEAT_JOB_ID = 'heartbeat'

/** 心跳静默约定：回复首个非空行只含该 token 时本轮不通知、不推送 */
export const HEARTBEAT_OK = 'HEARTBEAT_OK'

export const MIN_INTERVAL_MINUTES = 1
export const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000
/** 连续失败达到该值后任务自动停用，防 token 暴走 */
export const AUTO_DISABLE_ERROR_THRESHOLD = 5
/** 错过补跑窗口：错过不超过 1 小时且任务开启 catchUp 才补跑 */
export const CATCHUP_WINDOW_MS = 60 * 60 * 1000

export interface DailySchedule {
  kind: 'daily'
  /** 'HH:mm' 24 小时制（本地时间） */
  time: string
}

export interface WeeklySchedule {
  kind: 'weekly'
  /** 0=周日 … 6=周六 */
  weekday: number
  /** 'HH:mm' 24 小时制（本地时间） */
  time: string
}

export interface IntervalSchedule {
  kind: 'interval'
  minutes: number
}

export type Schedule = DailySchedule | WeeklySchedule | IntervalSchedule

export interface QuietHours {
  /** 'HH:mm'，可跨午夜（如 22:00 → 08:00） */
  start: string
  end: string
}

export interface ScheduledJob {
  id: string
  name: string
  kind: 'cron' | 'heartbeat'
  schedule: Schedule
  /** cron 专用指令；heartbeat 为 null（注入 HEARTBEAT.md） */
  prompt: string | null
  /** 绑定的持久会话，首次运行后回填 */
  sessionId: string | null
  enabled: boolean
  approveMode: AutoApproveMode
  providerId: string | null
  maxRounds: number | null
  quietHours: QuietHours | null
  /** 睡眠/重启错过窗口内是否补跑一次 */
  catchUp: boolean
  timeoutMs: number
  consecutiveErrors: number
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}

export type ScheduledRunStatus = 'running' | 'ok' | 'silent' | 'skipped' | 'error'

export interface ScheduledRun {
  id: string
  jobId: string
  startedAt: number
  finishedAt: number | null
  status: ScheduledRunStatus
  summary: string | null
  inputTokens: number
  outputTokens: number
  error: string | null
}

/** 管理页展示用的任务视图（main 组合 ScheduledJob + 运行态 + 最近一次运行） */
export interface ScheduledJobView {
  id: string
  name: string
  kind: 'cron' | 'heartbeat'
  schedule: Schedule
  prompt: string | null
  enabled: boolean
  approveMode: AutoApproveMode
  providerId: string | null
  maxRounds: number | null
  quietHours: QuietHours | null
  catchUp: boolean
  timeoutMs: number
  consecutiveErrors: number
  nextRunAt: number | null
  sessionId: string | null
  /** 该任务当前正在执行 */
  running: boolean
  /** 因连续失败被自动停用 */
  autoDisabled: boolean
  lastRun: { status: ScheduledRunStatus; summary: string | null; error: string | null; finishedAt: number | null } | null
}

// ============================================================
// 归一化 / 校验（IPC 边界运行时校验用）
// ============================================================

export function isTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function normalizeSchedule(input: unknown): Schedule | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  if (raw.kind === 'daily' && isTimeOfDay(raw.time)) return { kind: 'daily', time: raw.time }
  if (raw.kind === 'weekly'
    && isTimeOfDay(raw.time)
    && typeof raw.weekday === 'number'
    && Number.isInteger(raw.weekday)
    && raw.weekday >= 0 && raw.weekday <= 6) {
    return { kind: 'weekly', weekday: raw.weekday, time: raw.time }
  }
  if (raw.kind === 'interval'
    && typeof raw.minutes === 'number'
    && Number.isInteger(raw.minutes)
    && raw.minutes >= MIN_INTERVAL_MINUTES) {
    return { kind: 'interval', minutes: raw.minutes }
  }
  return null
}

export function normalizeQuietHours(input: unknown): QuietHours | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  if (isTimeOfDay(raw.start) && isTimeOfDay(raw.end)) return { start: raw.start, end: raw.end }
  return null
}

export function normalizeApproveMode(input: unknown): AutoApproveMode {
  return input === 'auto' || input === 'full' ? input : 'manual'
}

export function validateJobInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'Invalid task.'
  const raw = input as Record<string, unknown>
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.trim().length > 80) {
    return 'Task name must be 1-80 characters.'
  }
  if (raw.kind !== 'cron' && raw.kind !== 'heartbeat') return 'Unknown task kind.'
  const schedule = normalizeSchedule(raw.schedule)
  if (!schedule) return 'Invalid schedule.'
  if (raw.kind === 'cron' && (typeof raw.prompt !== 'string' || raw.prompt.trim().length === 0)) {
    return 'Cron task requires a prompt.'
  }
  const quietHours = raw.quietHours === null || raw.quietHours === undefined ? null : normalizeQuietHours(raw.quietHours)
  if (raw.quietHours !== null && raw.quietHours !== undefined && !quietHours) return 'Invalid quiet hours.'
  if (raw.maxRounds !== null && raw.maxRounds !== undefined
    && (!Number.isInteger(raw.maxRounds) || (raw.maxRounds as number) < 0)) {
    return 'maxRounds must be a non-negative integer or null.'
  }
  if (raw.timeoutMs !== undefined && (!Number.isInteger(raw.timeoutMs) || (raw.timeoutMs as number) <= 0)) {
    return 'timeoutMs must be a positive integer.'
  }
  return null
}

/** 归一化后的新建任务输入（IPC 边界把 raw 转成这个干净形状再交给 main） */
export interface NewScheduledJobInput {
  name: string
  kind: 'cron' | 'heartbeat'
  schedule: Schedule
  prompt: string | null
  approveMode: AutoApproveMode
  providerId: string | null
  maxRounds: number | null
  quietHours: QuietHours | null
  catchUp: boolean
  timeoutMs: number
}

/** 校验通过后把 raw 输入转成干净形状；非法字段回退默认值而非抛错 */
export function normalizeJobInput(input: unknown): NewScheduledJobInput {
  const raw = (input || {}) as Record<string, unknown>
  const schedule = normalizeSchedule(raw.schedule) ?? { kind: 'interval', minutes: 60 }
  return {
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : 'Scheduled Task',
    kind: raw.kind === 'heartbeat' ? 'heartbeat' : 'cron',
    schedule,
    prompt: typeof raw.prompt === 'string' && raw.prompt.trim().length > 0 ? raw.prompt.trim() : null,
    approveMode: normalizeApproveMode(raw.approveMode),
    providerId: typeof raw.providerId === 'string' && raw.providerId ? raw.providerId : null,
    maxRounds: Number.isInteger(raw.maxRounds) && (raw.maxRounds as number) >= 0 ? (raw.maxRounds as number) : null,
    quietHours: normalizeQuietHours(raw.quietHours),
    catchUp: raw.catchUp === true,
    timeoutMs: Number.isInteger(raw.timeoutMs) && (raw.timeoutMs as number) > 0
      ? (raw.timeoutMs as number)
      : DEFAULT_JOB_TIMEOUT_MS
  }
}

// ============================================================
// 调度纯函数
// ============================================================

function minutesOfDay(value: string): number {
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

function dayStartOf(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 严格晚于 after 的下一次触发时间（本地时区） */
export function computeNextRun(schedule: Schedule, after: number): number {
  switch (schedule.kind) {
    case 'daily':
      return nextDaily(schedule.time, after)
    case 'weekly':
      return nextWeekly(schedule.weekday, schedule.time, after)
    case 'interval':
      return after + schedule.minutes * 60_000
  }
}

function nextDaily(time: string, after: number): number {
  const target = dayStartOf(after) + minutesOfDay(time) * 60_000
  return target > after ? target : target + 86_400_000
}

function nextWeekly(weekday: number, time: string, after: number): number {
  const day = new Date(after).getDay()
  const target = dayStartOf(after) + (weekday - day) * 86_400_000 + minutesOfDay(time) * 60_000
  return target > after ? target : target + 7 * 86_400_000
}

/** 错过（计划时间已过）后的处理：补跑一次，或跳过到下个周期 */
export function resolveMissedRun(
  schedule: Schedule,
  plannedAt: number,
  now: number,
  catchUp: boolean
): { action: 'run' | 'skip'; nextRunAt: number } {
  const next = computeNextRun(schedule, now)
  const catchable = catchUp && plannedAt >= now - CATCHUP_WINDOW_MS
  return { action: catchable ? 'run' : 'skip', nextRunAt: next }
}

/** 免打扰时段判断；start==end 视为未启用 */
export function isWithinQuietHours(quietHours: QuietHours | null, ts: number): boolean {
  if (!quietHours) return false
  const start = minutesOfDay(quietHours.start)
  const end = minutesOfDay(quietHours.end)
  if (start === end) return false
  const d = new Date(ts)
  const current = d.getHours() * 60 + d.getMinutes()
  return start < end ? current >= start && current < end : current >= start || current < end
}

/**
 * 若 ts 落在免打扰时段内，返回该时段结束的时间戳（运行延迟到那时）；否则返回 null。
 * 语义：quiet hours 延迟执行而非仅屏蔽通知，避免凌晨空跑烧 token。
 */
export function quietEndAfter(quietHours: QuietHours | null, ts: number): number | null {
  if (!quietHours || !isWithinQuietHours(quietHours, ts)) return null
  const start = minutesOfDay(quietHours.start)
  const end = minutesOfDay(quietHours.end)
  const base = dayStartOf(ts)
  const d = new Date(ts)
  const current = d.getHours() * 60 + d.getMinutes()
  if (start < end) {
    const todayEnd = base + end * 60_000
    return todayEnd > ts ? todayEnd : base + 86_400_000 + end * 60_000
  }
  // 跨午夜：晚间段（>=start）延到明天 end；凌晨段（<end）延到今天 end
  if (current >= start) return base + 86_400_000 + end * 60_000
  return base + end * 60_000
}

// ============================================================
// 心跳 prompt / 静默判定
// ============================================================

/** 工作区没有 HEARTBEAT.md 时的内置清单 */
export const DEFAULT_HEARTBEAT_CHECKLIST = [
  '- 检查记忆中是否有未完成的待办事项',
  '- 检查是否有需要跟进的长期任务'
].join('\n')

export function buildHeartbeatPrompt(checklist: string | null, now: number): string {
  const time = new Date(now).toLocaleString()
  const body = (checklist ?? '').trim().length > 0 ? checklist!.trim() : DEFAULT_HEARTBEAT_CHECKLIST
  return [
    `[心跳检查] 现在是 ${time}。按以下清单检查，需要用户关注的事项用一两句话汇报；`,
    '没有任何需要关注的事项时，第一行只回复 ' + HEARTBEAT_OK + '。',
    '---',
    body,
    '---'
  ].join('\n')
}

export function isHeartbeatSilent(reply: string | null | undefined): boolean {
  if (!reply) return false
  const firstLine = reply.split('\n').map(line => line.trim()).find(line => line.length > 0)
  return firstLine !== undefined && new RegExp(`^${HEARTBEAT_OK}\\.?$`).test(firstLine)
}

/** 预览用：从 now 起未来 n 次触发时间 */
export function previewSchedule(schedule: Schedule, from: number, count: number): number[] {
  const out: number[] = []
  let cursor = from
  for (let i = 0; i < count; i++) {
    cursor = computeNextRun(schedule, cursor)
    out.push(cursor)
  }
  return out
}
