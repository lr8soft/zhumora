// ============================================================
// 定时任务 IPC 层
// 只做输入校验 + 调用 SchedulerService / store；不含 Agent 决策。
// ============================================================
import { ipcMain, type BrowserWindow } from 'electron'
import * as db from '../store/db'
import { generateId } from '../id'
import { log } from '../llm/logger'
import type { SchedulerService } from '../scheduler'
import {
  computeNextRun,
  normalizeJobInput,
  normalizeQuietHours,
  normalizeSchedule,
  validateJobInput,
  type ScheduledJob,
  type ScheduledJobView
} from '../../shared/scheduled'

function toView(job: ScheduledJob, running: boolean): ScheduledJobView {
  const last = db.getScheduledRuns(job.id, 1)[0] ?? null
  return {
    id: job.id,
    name: job.name,
    kind: job.kind,
    schedule: job.schedule,
    prompt: job.prompt,
    enabled: job.enabled,
    approveMode: job.approveMode,
    providerId: job.providerId,
    maxRounds: job.maxRounds,
    quietHours: job.quietHours,
    catchUp: job.catchUp,
    timeoutMs: job.timeoutMs,
    consecutiveErrors: job.consecutiveErrors,
    nextRunAt: job.nextRunAt,
    sessionId: job.sessionId,
    running,
    autoDisabled: !job.enabled && job.consecutiveErrors > 0,
    lastRun: last ? { status: last.status, summary: last.summary, error: last.error, finishedAt: last.finishedAt } : null
  }
}

export function registerScheduledIpc(_win: BrowserWindow, scheduler: SchedulerService): void {
  ipcMain.handle('scheduled:list', () => {
    const running = new Set(scheduler.runningJobIds())
    return db.getScheduledJobs().map(job => toView(job, running.has(job.id)))
  })

  ipcMain.handle('scheduled:create', (_e, input: unknown) => {
    const invalid = validateJobInput(input)
    if (invalid) return { error: invalid }
    const job = normalizeJobInput(input)
    const id = generateId()
    const now = Date.now()
    db.insertScheduledJob(id, {
      ...job,
      nextRunAt: computeNextRun(job.schedule, now)
    })
    scheduler.reconcile(true)
    log('info', `Scheduled task created: ${job.name} (${id})`)
    return { ok: true, id }
  })

  ipcMain.handle('scheduled:update', (_e, id: unknown, patch: unknown) => {
    if (typeof id !== 'string' || !id) return { error: 'Invalid task id.' }
    const existing = db.getScheduledJob(id)
    if (!existing) return { error: 'Task not found.' }
    const raw = (patch || {}) as Record<string, unknown>

    const updates: db.UpdateScheduledJobInput = {}
    if (raw.name !== undefined) {
      if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.trim().length > 80) {
        return { error: 'Task name must be 1-80 characters.' }
      }
      updates.name = raw.name.trim()
    }
    if (raw.schedule !== undefined) {
      const schedule = normalizeSchedule(raw.schedule)
      if (!schedule) return { error: 'Invalid schedule.' }
      updates.schedule = schedule
    }
    if (raw.prompt !== undefined) {
      if (existing.kind === 'cron' && (typeof raw.prompt !== 'string' || raw.prompt.trim().length === 0)) {
        return { error: 'Cron task requires a prompt.' }
      }
      updates.prompt = typeof raw.prompt === 'string' && raw.prompt.trim().length > 0 ? raw.prompt.trim() : null
    }
    if (raw.approveMode !== undefined) {
      updates.approveMode = raw.approveMode === 'auto' || raw.approveMode === 'full' ? raw.approveMode : 'manual'
    }
    if (raw.providerId !== undefined) {
      updates.providerId = typeof raw.providerId === 'string' && raw.providerId ? raw.providerId : null
    }
    if (raw.maxRounds !== undefined) {
      updates.maxRounds = Number.isInteger(raw.maxRounds) && (raw.maxRounds as number) >= 0 ? (raw.maxRounds as number) : null
    }
    if (raw.quietHours !== undefined) {
      updates.quietHours = raw.quietHours === null ? null : normalizeQuietHours(raw.quietHours)
      if (raw.quietHours !== null && !updates.quietHours) return { error: 'Invalid quiet hours.' }
    }
    if (raw.catchUp !== undefined) updates.catchUp = raw.catchUp === true
    if (raw.timeoutMs !== undefined) {
      if (!Number.isInteger(raw.timeoutMs) || (raw.timeoutMs as number) <= 0) return { error: 'timeoutMs must be a positive integer.' }
      updates.timeoutMs = raw.timeoutMs as number
    }

    db.updateScheduledJob(id, updates)
    // schedule 变了 → 重算 nextRunAt（从 now 起）；否则保留
    if (updates.schedule) {
      db.updateScheduledJob(id, { nextRunAt: computeNextRun(updates.schedule, Date.now()) })
    }
    // 用户重新启用 → 清零失败计数（否则 autoDisabled 状态粘住）
    if (updates.enabled === true) {
      db.recordJobSuccess(id)
    }
    scheduler.reconcile(true)
    return { ok: true }
  })

  ipcMain.handle('scheduled:toggle', (_e, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || !id || typeof enabled !== 'boolean') return { error: 'Invalid input.' }
    const existing = db.getScheduledJob(id)
    if (!existing) return { error: 'Task not found.' }
    db.updateScheduledJob(id, { enabled })
    if (enabled) {
      // 重新启用：清零失败计数 + 重排下次运行
      db.recordJobSuccess(id)
      db.updateScheduledJob(id, { nextRunAt: computeNextRun(existing.schedule, Date.now()) })
    }
    scheduler.reconcile(true)
    return { ok: true }
  })

  ipcMain.handle('scheduled:delete', (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return { error: 'Invalid task id.' }
    if (scheduler.runningJobIds().includes(id)) {
      scheduler.abort(id)
    }
    db.deleteScheduledJob(id)
    scheduler.reconcile(true)
    log('info', `Scheduled task deleted: ${id}`)
    return { ok: true }
  })

  ipcMain.handle('scheduled:runNow', (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return { error: 'Invalid task id.' }
    return scheduler.runNow(id)
  })

  ipcMain.handle('scheduled:runs', (_e, id: unknown, limit: unknown) => {
    if (typeof id !== 'string' || !id) return { error: 'Invalid task id.' }
    const count = Number.isInteger(limit) && (limit as number) > 0 ? (limit as number) : 20
    return db.getScheduledRuns(id, Math.min(count, 100))
  })
}
