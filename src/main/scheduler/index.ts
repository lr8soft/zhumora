// ============================================================
// 定时任务调度器（scheduler channel）
//
// 设计原则（对齐 OpenClaw / Agent Zero 的通用模式）：
//   调度器只负责"到点生成一条消息"，Agent 执行完全复用
//   BotAgentBridge + BotRunCoordinator（会话/消息持久化、压缩、
//   记忆、权限、skip-if-busy、abort 语义全部免费获得）。
//
// 触发链路：timer 到期 → 纯函数决策（catch-up / quiet hours / busy）
//   → coordinator.enqueue → bridge.handle → 记录 scheduled_runs。
// ============================================================
import * as fs from 'node:fs'
import * as path from 'node:path'
import { AgentAbortedError } from '../../shared/types.ts'
import type { AppSettings } from '../../shared/types.ts'
import {
  AUTO_DISABLE_ERROR_THRESHOLD,
  CATCHUP_WINDOW_MS,
  buildHeartbeatPrompt,
  computeNextRun,
  isHeartbeatSilent,
  quietEndAfter,
  type ScheduledJob,
  type ScheduledRunStatus
} from '../../shared/scheduled.ts'
import { generateId } from '../id.ts'
import { log } from '../llm/logger.ts'
import type { AgentEventSink } from '../agent/persistedCallbacks.ts'
import type { BotAgentBridge } from '../bot/agentBridge.ts'
import { BotRunBusyError, type BotActivity } from '../bot/contracts.ts'
import { BotRunCoordinator, type BotRunContext } from '../bot/runCoordinator.ts'
import type { PermissionBroker } from '../agent/permissionBroker.ts'
import type * as db from '../store/db.ts'

/** 定时器到点但会话忙时的正常抖动容忍：5 分钟内视为"准点" */
const GRACE_MS = 5 * 60_000
/** setTimeout 上限 24.8 天；调度最远只排 7 天（weekly 上限） */
const MAX_ARM_DELAY_MS = 7 * 24 * 60 * 60_000
/** 全局并发上限：同时执行的调度任务数（超出的顺延 60s，不记 skipped） */
const MAX_CONCURRENT_RUNS = 2

export interface SchedulerStore {
  getScheduledJobs(): ScheduledJob[]
  getScheduledJob(id: string): ScheduledJob | null
  updateScheduledJob(id: string, patch: db.UpdateScheduledJobInput): void
  setJobSession(id: string, sessionId: string): void
  recordJobSuccess(id: string): void
  recordJobError(id: string, threshold: number): number
  insertScheduledRun(id: string, jobId: string, startedAt: number, status: ScheduledRunStatus): void
  finishScheduledRun(id: string, status: ScheduledRunStatus, extra?: {
    summary?: string | null
    error?: string | null
    inputTokens?: number
    outputTokens?: number
  }): void
  getSettings(): AppSettings
}

interface SchedulerDependencies {
  store: SchedulerStore
  agent: BotAgentBridge
  permissions: PermissionBroker
  /** 时钟（可注入；测试用固定时间）。默认 Date.now */
  now?: () => number
}

interface RunOutcome {
  status: Exclude<ScheduledRunStatus, 'running'>
  summary: string | null
  error: string | null
  inputTokens: number
  outputTokens: number
}

/** 心跳检查清单文件名（位于全局 workspace 下；不存在时用内置清单） */
const HEARTBEAT_FILE = 'HEARTBEAT.md'

export class SchedulerService {
  private readonly deps: SchedulerDependencies
  readonly runs: BotRunCoordinator
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private generation = 0
  private agentEvents: AgentEventSink = {}
  /** 正在执行（已 enqueue 未 settle）的 jobId；全局并发上限用 */
  private readonly inFlight = new Set<string>()

  constructor(deps: SchedulerDependencies) {
    this.deps = deps
    this.now = deps.now || (() => Date.now())
    this.runs = new BotRunCoordinator(deps.permissions)
  }

  /** 可注入时钟（默认 Date.now；测试用固定/受控时间） */
  private readonly now: () => number
  /**
   * 会话忙判定（可注入）。默认只看本 coordinator 的运行；
   * IPC 层会覆盖为"runtime.runningSessions ∪ 本 coordinator"，
   * 从而在用户在 UI 手动跑同一会话时跳过触发（skip-if-busy）。
   */
  private busyCheck: ((sessionId: string) => boolean) | null = null

  /** 由 IPC 层注入 renderer 事件 sink（与 bot 平台同一套接线） */
  setAgentEventSink(sink: AgentEventSink): void {
    this.agentEvents = sink
  }

  /** 由 IPC 层注入运行状态监听（驱动侧边栏 spinner / runtime.runningSessions） */
  setActivityListener(listener: (activity: BotActivity) => boolean | void): void {
    this.runs.setActivityListener(listener)
  }

  /**
   * 由 IPC 层注入会话忙判定。覆盖默认（只看本 coordinator）为
   * "runtime.runningSessions ∪ 本 coordinator"，使 scheduler 在用户
   * 于 UI 手动运行同一会话时跳过触发。
   */
  setBusyCheck(check: ((sessionId: string) => boolean) | null): void {
    this.busyCheck = check
  }

  /** app 启动：错过"关机期间"的任务不补跑（allowCatchUp=false） */
  start(): void {
    if (this.started) return
    this.started = true
    this.reconcile(false)
  }

  async stop(): Promise<void> {
    this.started = false
    this.generation++
    this.clearTimer()
    await this.runs.stop()
    this.inFlight.clear()
  }

  /**
   * 从 DB 全量重建内存调度状态。
   * allowCatchUp=false（app 启动）：错过超过 GRACE 的一律跳过——
   * "关机错过"不补跑。true（powerMonitor resume / 任务变更）：
   * 按 job.catchUp + CATCHUP_WINDOW_MS 补跑"睡眠错过"。
   */
  reconcile(allowCatchUp: boolean): void {
    this.generation++
    this.clearTimer()
    const now = this.now()
    const jobs = this.deps.store.getScheduledJobs().filter(job => job.enabled && job.nextRunAt !== null)
    for (const job of jobs) {
      const planned = job.nextRunAt!
      if (planned > now) continue
      const lag = now - planned
      if (lag > CATCHUP_WINDOW_MS) {
        this.reschedule(job, now, 'missed beyond catch-up window')
        continue
      }
      if (lag > GRACE_MS && (!allowCatchUp || !job.catchUp)) {
        this.reschedule(job, now, allowCatchUp ? 'missed (catch-up disabled)' : 'missed while app was closed')
        continue
      }
      this.fire(job, now)
    }
    this.arm()
  }

  /** 手动立即触发（调试/用户操作）：force 绕过 quiet hours 判定 */
  runNow(jobId: string): { ok: boolean; error?: string } {
    const job = this.deps.store.getScheduledJob(jobId)
    if (!job) return { ok: false, error: 'Task not found.' }
    this.fire(job, this.now(), true)
    return { ok: true }
  }

  abort(jobId: string): boolean {
    return this.runs.abortConversation(jobId)
  }

  activeSessionIds(): string[] {
    return this.runs.activeSessionIds()
  }

  /** 正在执行（已 fire 未 settle）的任务 id，供管理页展示运行状态 */
  runningJobIds(): string[] {
    return [...this.inFlight]
  }

  // ============================================================
  // 触发
  // ============================================================

  /** force=true（手动 runNow）绕过 quiet hours；正常触发统一在这里延迟免打扰时段 */
  private fire(job: ScheduledJob, now: number, force = false): void {
    if (!job.enabled || this.inFlight.has(job.id)) return
    if (!force) {
      const quietEnd = quietEndAfter(job.quietHours, now)
      if (quietEnd) {
        this.deps.store.updateScheduledJob(job.id, { nextRunAt: quietEnd })
        log('info', `Scheduled task "${job.name}" due during quiet hours; deferred to ${new Date(quietEnd).toLocaleTimeString()}`)
        this.arm()
        return
      }
    }
    // 会话正忙（用户也在该任务会话里跑 / UI 手动运行同一会话）→ skip-if-busy，记 skipped
    const busy = this.busyCheck ?? (sid => this.runs.isSessionActive(sid))
    if (job.sessionId && busy(job.sessionId)) {
      this.finishSkipped(job, 'session busy', now)
      return
    }
    // 全局并发上限：超出的顺延重试（内部背压，不记 skipped）。
    // 顺延目标 = max(其他在跑任务的最早 nextRunAt, now+60s)，保证严格在未来（防 0 延迟自旋）。
    if (this.inFlight.size >= MAX_CONCURRENT_RUNS) {
      const otherNext = this.deps.store
        .getScheduledJobs()
        .filter(j => j.id !== job.id && j.enabled && j.nextRunAt !== null && j.nextRunAt > now)
        .map(j => j.nextRunAt!)
      const deferTo = otherNext.length > 0 ? Math.max(Math.min(...otherNext), now + 60_000) : now + 60_000
      this.deps.store.updateScheduledJob(job.id, { nextRunAt: deferTo })
      this.arm()
      return
    }
    // 先把下次运行排好（执行期间任务仍可按新周期继续）
    const next = computeNextRun(job.schedule, now)
    this.deps.store.updateScheduledJob(job.id, { nextRunAt: next })
    this.inFlight.add(job.id)
    const runId = generateId()
    this.deps.store.insertScheduledRun(runId, job.id, now, 'running')
    const prompt = this.buildPrompt(job, now)
    const generation = this.generation
    void this.runs.enqueue(job.id, ctx => this.execute(job, prompt, ctx, runId), { timeoutMs: job.timeoutMs })
      .catch((error) => {
        // execute 内部成功路径已 finalize；这里是 handle 抛错（busy/abort/其他）的路径
        if (generation !== this.generation) return
        this.finalizeRun(runId, job, this.classifyFailure(error))
      })
      .finally(() => {
        this.inFlight.delete(job.id)
        this.arm()
      })
  }

  /** 执行一次任务回合：走 BotAgentBridge（与 Telegram/QQ 完全相同的链路），成功则落库 */
  private async execute(job: ScheduledJob, prompt: string, ctx: BotRunContext, runId: string): Promise<void> {
    const outcome = await this.runOnce(job, prompt, ctx)
    this.finalizeRun(runId, job, outcome)
  }

  /** 跑一个 Agent 回合并归类结果；handle 抛错（busy/abort/其他）时向上抛，由调用方分类 */
  private async runOnce(job: ScheduledJob, prompt: string, ctx: BotRunContext): Promise<RunOutcome> {
    const usage = { inputTokens: 0, outputTokens: 0 }
    let lastComplete: string | null = null
    const tracking: AgentEventSink = {
      complete: (sessionId, messageId, content) => {
        lastComplete = content
        this.agentEvents.complete?.(sessionId, messageId, content)
      },
      usage: (model, inputTokens, outputTokens) => {
        usage.inputTokens += inputTokens
        usage.outputTokens += outputTokens
        this.agentEvents.usage?.(model, inputTokens, outputTokens)
      }
    }
    // 其余事件直通 renderer sink（token 流、工具调用、持久化等）
    const events: AgentEventSink = {
      userMessage: this.agentEvents.userMessage,
      assistantStart: this.agentEvents.assistantStart,
      token: this.agentEvents.token,
      reasoning: this.agentEvents.reasoning,
      toolCall: this.agentEvents.toolCall,
      toolResult: this.agentEvents.toolResult,
      assistantEnd: this.agentEvents.assistantEnd,
      retry: this.agentEvents.retry,
      truncated: this.agentEvents.truncated,
      compact: this.agentEvents.compact,
      ...tracking
    }
    await this.deps.agent.handle({
      channel: 'scheduler',
      accountId: 'local',
      conversationId: job.id,
      conversationTitle: `Scheduled · ${job.name}`,
      senderId: 'scheduler',
      senderName: 'Scheduler',
      text: prompt,
      approveMode: job.approveMode,
      providerId: job.providerId ?? undefined,
      maxRounds: job.maxRounds ?? undefined,
      signal: ctx.signal,
      events,
      onSessionReady: sessionId => {
        const ok = ctx.onSessionReady(sessionId)
        if (ok) this.deps.store.setJobSession(job.id, sessionId)
        return ok
      }
    })
    // handle 正常返回；若 signal 被超时 abort，runner 按部分内容完成（不抛错）
    if (ctx.signal.aborted) {
      return { status: 'error', summary: null, error: `timeout after ${Math.round(job.timeoutMs / 60000)}m`, ...usage }
    }
    if (job.kind === 'heartbeat' && isHeartbeatSilent(lastComplete)) {
      return { status: 'silent', summary: HEARTBEAT_OK_SUMMARY, error: null, ...usage }
    }
    return { status: 'ok', summary: summarize(lastComplete), error: null, ...usage }
  }

  /** 落库一条运行结果 + 更新任务失败计数 + 日志（唯一 finalize 出口） */
  private finalizeRun(runId: string, job: ScheduledJob, outcome: RunOutcome): void {
    this.deps.store.finishScheduledRun(runId, outcome.status, {
      summary: outcome.summary,
      error: outcome.error,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens
    })
    if (outcome.status === 'error') {
      const count = this.deps.store.recordJobError(job.id, AUTO_DISABLE_ERROR_THRESHOLD)
      log('error', `Scheduled task "${job.name}" failed (${count}/${AUTO_DISABLE_ERROR_THRESHOLD}): ${outcome.error}`)
    } else if (outcome.status === 'skipped') {
      this.deps.store.recordJobSuccess(job.id)
      log('info', `Scheduled task "${job.name}" skipped: ${outcome.summary ?? 'busy'}`)
    } else {
      this.deps.store.recordJobSuccess(job.id)
      if (outcome.status === 'silent') log('info', `Heartbeat "${job.name}" silent (OK)`)
      else log('info', `Scheduled task "${job.name}" completed`)
    }
  }

  /** enqueue 抛错时的结果分类（busy=skip；abort=超时或用户停止；其余=error） */
  private classifyFailure(error: unknown): RunOutcome {
    if (error instanceof BotRunBusyError) {
      return { status: 'skipped', summary: 'session busy', error: null, inputTokens: 0, outputTokens: 0 }
    }
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof AgentAbortedError) {
      return { status: 'error', summary: null, error: 'aborted (timeout or user stop)', inputTokens: 0, outputTokens: 0 }
    }
    return { status: 'error', summary: null, error: message.slice(0, 500), inputTokens: 0, outputTokens: 0 }
  }

  private finishSkipped(job: ScheduledJob, reason: string, now: number): void {
    const runId = generateId()
    this.deps.store.insertScheduledRun(runId, job.id, now, 'skipped')
    const next = computeNextRun(job.schedule, now)
    this.deps.store.updateScheduledJob(job.id, { nextRunAt: next })
    this.deps.store.finishScheduledRun(runId, 'skipped', { summary: reason })
    this.deps.store.recordJobSuccess(job.id)
    this.arm()
  }

  private reschedule(job: ScheduledJob, now: number, reason: string): void {
    const next = computeNextRun(job.schedule, now)
    this.deps.store.updateScheduledJob(job.id, { nextRunAt: next })
    log('info', `Scheduled task "${job.name}": ${reason}; next run rescheduled`)
  }

  // ============================================================
  // Prompt 构建
  // ============================================================

  private buildPrompt(job: ScheduledJob, now: number): string {
    if (job.kind === 'heartbeat') {
      return buildHeartbeatPrompt(this.readHeartbeatChecklist(), now)
    }
    return buildCronPrompt(job.name, job.prompt ?? '')
  }

  private readHeartbeatChecklist(): string | null {
    try {
      const settings = this.deps.store.getSettings()
      const file = path.join(settings.workspacePath, HEARTBEAT_FILE)
      const content = fs.readFileSync(file, 'utf-8')
      return content.trim().length > 0 ? content : null
    } catch {
      return null
    }
  }

  // ============================================================
  // Timer
  // ============================================================

  private arm(): void {
    if (!this.started) return
    this.clearTimer()
    const now = this.now()
    const next = this.deps.store
      .getScheduledJobs()
      .filter(job => job.enabled && job.nextRunAt !== null)
      .map(job => job.nextRunAt!)
      .sort((a, b) => a - b)[0]
    if (next === undefined) return
    const delay = Math.min(Math.max(next - now, 0), MAX_ARM_DELAY_MS)
    const generation = this.generation
    this.timer = setTimeout(() => {
      this.timer = null
      if (generation !== this.generation) return
      const due = this.now()
      for (const job of this.deps.store.getScheduledJobs()) {
        if (job.enabled && job.nextRunAt !== null && job.nextRunAt <= due) {
          // fire 内部 finally 会重新 arm；这里不再 arm，避免无到期任务时 0 延迟自旋
          this.fire(job, due)
        }
      }
    }, delay)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

/** 心跳静默运行记录的摘要文案 */
const HEARTBEAT_OK_SUMMARY = 'HEARTBEAT_OK (silent)'

/** cron 任务触发回合的 prompt：标注来源，避免模型误以为是用户实时输入 */
export function buildCronPrompt(name: string, prompt: string): string {
  return [
    `[定时任务: ${name}]`,
    prompt.trim(),
    '（由调度器自动触发，非用户实时输入。直接开始执行任务。）'
  ].join('\n')
}

/** 运行摘要：取回复首个非空行，截断到 200 字符（列表页展示） */
export function summarize(content: string | null): string | null {
  if (!content) return null
  const first = content.split('\n').map(line => line.trim()).find(line => line.length > 0)
  if (!first) return null
  return first.length > 200 ? first.slice(0, 200) + '…' : first
}
