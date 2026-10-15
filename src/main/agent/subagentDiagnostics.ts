import type { AgentEventSink } from './persistedCallbacks.ts'
import { isTerminalMcpTaskStatus, type McpTaskSession, type McpTaskStatus } from './taskProtocol.ts'
import { classifySubagentFailure, subagentRecovery, type SubagentFailure, type SubagentFailureKind } from './subagentRecovery.ts'

export interface SubagentDiagnosticsSnapshot {
  run_number: number
  continued_from_task_id?: string
  phase: 'preparing' | 'generating' | 'reasoning' | 'tool' | 'retrying' | 'awaiting_permission' | 'settling' | 'settled'
  last_activity_at: number
  tools_completed: number
  tool_errors: number
  last_tool?: { name: string; status: 'running' | 'completed' | 'failed' }
  retry?: { failed_attempt: number; max_retries: number; kind: SubagentFailureKind }
  incomplete_outputs: number
  failure?: SubagentFailure
}

/** One child turn's bounded event projection. No controller, run registry, timer or message-history copy. */
export class SubagentRunDiagnostics {
  readonly runNumber: number
  private readonly previousTaskId?: string
  private readonly previousFailure?: SubagentFailureKind
  private data: SubagentDiagnosticsSnapshot

  constructor(previous?: { runNumber: number; taskId: string; failure?: SubagentFailureKind }) {
    this.runNumber = (previous?.runNumber ?? 0) + 1
    this.previousTaskId = previous?.taskId
    this.previousFailure = previous?.failure
    this.data = { run_number: this.runNumber, phase: 'preparing', last_activity_at: Date.now(), tools_completed: 0,
      tool_errors: 0, incomplete_outputs: 0 }
  }

  failureKind(): SubagentFailureKind | undefined { return this.data.failure?.kind }

  started(): void { if (this.data.phase === 'preparing') this.touch('generating') }

  fail(error: unknown, stage: SubagentFailure['stage']): void {
    this.data.failure ??= classifySubagentFailure(error, stage)
    this.touch('settling')
  }

  noDeliverable(): void {
    this.data.failure ??= { kind: 'no_deliverable', stage: 'runtime' }
    this.touch('settling')
  }

  snapshot(status: McpTaskStatus['status'], settled: boolean, latest: boolean) {
    const phase = status === 'awaiting_permission' ? 'awaiting_permission'
      : status !== 'running' && status !== 'busy' ? settled ? 'settled' : 'settling' : this.data.phase
    return { diagnostics: { ...this.data, phase, ...(this.previousTaskId ? { continued_from_task_id: this.previousTaskId } : {}),
      ...(this.data.last_tool ? { last_tool: { ...this.data.last_tool } } : {}),
      ...(this.data.retry ? { retry: { ...this.data.retry } } : {}),
      ...(this.data.failure ? { failure: { ...this.data.failure } } : {}) },
    recovery: subagentRecovery(status, settled, latest, this.data.failure, this.previousFailure) }
  }

  private touch(phase: SubagentDiagnosticsSnapshot['phase']): void {
    this.data.phase = phase; this.data.last_activity_at = Date.now()
  }

  events(task: McpTaskSession): AgentEventSink {
    const sink = task.sink
    const active = () => !isTerminalMcpTaskStatus(task.status())
    return { ...sink,
      assistantStart: (...args) => { if (active()) this.touch('generating'); sink.assistantStart?.(...args) },
      token: (...args) => { if (active()) this.touch('generating'); sink.token?.(...args) },
      reasoning: (...args) => { if (active()) this.touch('reasoning'); sink.reasoning?.(...args) },
      toolCall: (...args) => {
        if (active()) { this.touch('tool'); this.data.last_tool = { name: args[2].function.name.slice(0, 120), status: 'running' } }
        sink.toolCall?.(...args)
      },
      toolResult: (...args) => {
        if (active()) {
          this.touch('generating'); this.data.tools_completed++; if (args[4]) this.data.tool_errors++
          this.data.last_tool = { name: args[2].slice(0, 120), status: args[4] ? 'failed' : 'completed' }
        }
        sink.toolResult?.(...args)
      },
      retry: (...args) => {
        if (active()) { this.touch('retrying'); this.data.retry = { failed_attempt: args[1], max_retries: args[2], kind: classifySubagentFailure(args[3], 'runtime').kind } }
        sink.retry?.(...args)
      },
      truncated: (...args) => { if (active()) { this.touch('generating'); this.data.incomplete_outputs++ }; sink.truncated?.(...args) },
      error: (...args) => { if (active()) this.fail(args[1], 'runtime'); sink.error?.(...args) },
      aborted: (...args) => { if (active()) this.touch('settling'); sink.aborted?.(...args) },
      complete: (...args) => {
        if (active()) this.touch('settling')
        if (active() && !args[2].trim()) {
          this.noDeliverable(); task.settle({ status: 'failed', error: 'Subagent ended without a final deliverable.' })
        } else sink.complete?.(...args)
      }
    }
  }
}
