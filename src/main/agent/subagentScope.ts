import { generateId } from '../id.ts'
import { AgentAbortedError, type Session } from '../../shared/types.ts'
import { createMcpTaskSession, DelegatePermissionPresenter, isTerminalMcpTaskStatus, type McpTaskSession, type McpTaskStatus } from './taskProtocol.ts'
import type { AgentEventSink } from './persistedCallbacks.ts'
import type { PermissionPresenter } from './permissionBroker.ts'
import { SUBAGENT_LIMITS, validateSubagentPrompt, validateSubagentRequest, type SubagentRequest } from './subagentPolicy.ts'
import { awaitWithSignal, waitUntilDeadline } from './runWait.ts'

export interface SubagentHost {
  resolveModel(request: SubagentRequest): { providerId: string; model: string }
  createSession(description: string, model: { providerId: string; model: string }): Session
  start(sessionId: string, prompt: string, events: AgentEventSink, presenter: PermissionPresenter): Promise<{ completion: Promise<void> }>
  isRunning(sessionId: string): boolean
  stop(sessionId: string): Promise<void>
  waitIdle(sessionId: string): Promise<void>
}

interface ChildTask {
  session: Session
  task: McpTaskSession
  starting: boolean
}

export interface SubagentTaskResult {
  task_id: string
  session_id: string
  parentSessionId?: string
  providerId?: string
  model?: string
  status: McpTaskStatus['status']
  settled: boolean
  reply?: string
  truncated?: boolean
  error?: string
  permission?: Pick<Extract<McpTaskStatus, { status: 'awaiting_permission' }>['permission'], 'permissionId' | 'toolName' | 'level'>
}

/** A parent-run-owned projection of delegated tasks. Controllers and execution stay in SessionService. */
export class SubagentScope {
  private readonly tasks = new Map<string, ChildTask>()
  private closed = false
  private turns = 0
  private closing?: Promise<void>
  private readonly host: SubagentHost
  private readonly signal?: AbortSignal

  constructor(host: SubagentHost, signal?: AbortSignal) { this.host = host; this.signal = signal }

  async spawn(request: SubagentRequest): Promise<SubagentTaskResult> {
    validateSubagentRequest(request)
    this.checkCapacity()
    const model = this.host.resolveModel(request)
    const session = this.host.createSession(request.description.trim(), model)
    return this.start(session, request.prompt)
  }

  async continue(taskId: string, prompt: string): Promise<SubagentTaskResult> {
    validateSubagentPrompt(prompt)
    const child = this.get(taskId)
    this.checkLatest(child)
    if (child.starting || this.host.isRunning(child.session.id)) throw new Error('Subagent is busy. Wait for its turn to settle.')
    if (!isTerminalMcpTaskStatus(child.task.status())) throw new Error('Subagent has not finished its previous turn.')
    this.checkCapacity()
    return this.start(child.session, prompt)
  }

  async wait(taskIds: string[], waitMs = 30000): Promise<SubagentTaskResult[]> {
    if (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > SUBAGENT_LIMITS.turns
      || taskIds.some(id => typeof id !== 'string') || new Set(taskIds).size !== taskIds.length) {
      throw new Error('task_ids must contain 1–8 unique task IDs from this run.')
    }
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw new Error('wait_ms must be an integer from 0 to 60000.')
    const children = taskIds.map(id => this.get(id))
    const deadline = Date.now() + waitMs
    // Reuse taskProtocol's terminal/permission wait; no polling loop or second event bus.
    await awaitWithSignal(Promise.all(children.map(child => child.task.wait(Math.max(0, deadline - Date.now())))), this.signal)
    if (Date.now() < deadline) {
      await waitUntilDeadline(Promise.all(children.filter(child => isTerminalMcpTaskStatus(child.task.status()) && this.isLatest(child))
        .map(child => this.host.waitIdle(child.session.id))), deadline, this.signal)
    }
    return children.map(child => this.result(child))
  }

  async cancel(taskId: string): Promise<SubagentTaskResult> {
    const child = this.get(taskId)
    if (isTerminalMcpTaskStatus(child.task.status())) {
      if (this.isLatest(child)) await awaitWithSignal(this.host.stop(child.session.id), this.signal)
      return this.result(child)
    }
    this.checkLatest(child)
    await awaitWithSignal(this.host.stop(child.session.id), this.signal)
    if (!isTerminalMcpTaskStatus(child.task.status())) child.task.settle({ status: 'aborted' })
    return this.result(child)
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const children = [...new Map([...this.tasks.values()].map(child => [child.session.id, child])).values()]
    this.closing = Promise.all(children.map(async child => {
      await this.host.stop(child.session.id)
      if (!isTerminalMcpTaskStatus(child.task.status())) child.task.settle({ status: 'aborted' })
    })).then(() => { this.tasks.clear() })
    return this.closing
  }

  private checkCapacity(): void {
    if (this.closed || this.signal?.aborted) throw new AgentAbortedError()
    if (this.turns >= SUBAGENT_LIMITS.turns) throw new Error('Subagent turn limit reached (8 per parent run).')
    const sessions = new Set([...this.tasks.values()]
      .filter(child => child.starting || this.host.isRunning(child.session.id)).map(child => child.session.id))
    if (sessions.size >= SUBAGENT_LIMITS.concurrent) throw new Error('Subagent concurrency limit reached (4). Wait before spawning more.')
  }

  private get(taskId: string): ChildTask {
    if (this.closed || this.signal?.aborted) throw new AgentAbortedError()
    const child = this.tasks.get(taskId)
    if (!child) throw new Error('Unknown task_id: only tasks owned by this parent run are accessible.')
    return child
  }

  private checkLatest(child: ChildTask): void {
    if (!this.isLatest(child)) throw new Error('Stale task_id. Use the task_id returned by the latest continuation.')
  }

  private isLatest(child: ChildTask): boolean {
    return [...this.tasks.values()].filter(item => item.session.id === child.session.id).at(-1) === child
  }

  private async start(session: Session, prompt: string): Promise<SubagentTaskResult> {
    const task = createMcpTaskSession(generateId())
    const child: ChildTask = { session, task, starting: true }
    this.tasks.set(task.taskId, child)
    this.turns++
    try {
      const startup = this.host.start(session.id, prompt, task.sink, new DelegatePermissionPresenter(task))
      // The observer survives the wait: any late handle is drained rather than becoming an orphan.
      void startup.then(async handle => {
        void handle.completion.then(() => {
          if (!isTerminalMcpTaskStatus(task.status())) task.settle({ status: 'failed', error: 'Subagent ended without a final deliverable.' })
        }, error => task.settle(error instanceof AgentAbortedError
          ? { status: 'aborted' } : { status: 'failed', error: String(error) }))
        if (this.closed || this.signal?.aborted) await this.host.stop(session.id)
      }).catch(error => task.settle(error instanceof AgentAbortedError
        ? { status: 'aborted' } : { status: 'failed', error: String(error) }))
      await awaitWithSignal(startup, this.signal)
      if (this.closed) {
        await this.host.stop(session.id)
        throw new AgentAbortedError()
      }
      child.starting = false
      return this.result(child)
    } catch (error) {
      child.starting = false
      task.settle(error instanceof AgentAbortedError ? { status: 'aborted' } : { status: 'failed', error: String(error) })
      if (error instanceof AgentAbortedError) throw error
      return this.result(child)
    } finally { child.starting = false }
  }

  private result(child: ChildTask): SubagentTaskResult {
    const status: McpTaskStatus = child.task.status()
    const bounded = status.status === 'completed'
      ? { ...status, reply: status.reply.slice(0, SUBAGENT_LIMITS.resultChars), truncated: status.reply.length > SUBAGENT_LIMITS.resultChars }
      : status.status === 'awaiting_permission'
        ? { status: status.status, permission: { permissionId: status.permission.permissionId, toolName: status.permission.toolName, level: status.permission.level } }
        : status.status === 'failed' ? { ...status, error: status.error.slice(0, 1000) } : status
    const settled = !child.starting && (!this.isLatest(child) || !this.host.isRunning(child.session.id))
    return { task_id: child.task.taskId, session_id: child.session.id, ...child.session.subagent, ...bounded, settled }
  }
}
