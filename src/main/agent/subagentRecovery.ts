import type { McpTaskStatus } from './taskProtocol.ts'

export type SubagentFailureKind = 'network' | 'timeout' | 'rate_limit' | 'provider_unavailable'
  | 'configuration' | 'context_limit' | 'no_deliverable' | 'unknown'

export interface SubagentFailure {
  kind: SubagentFailureKind
  stage: 'startup' | 'runtime'
  http_status?: number
}

/** Classification is advisory; it neither retries requests nor grants permission to start a run. */
export function classifySubagentFailure(error: unknown, stage: SubagentFailure['stage']): SubagentFailure {
  const value = error && typeof error === 'object' ? error as { name?: string; message?: string; status?: number; code?: string; cause?: { code?: string } } : {}
  const message = typeof value.message === 'string' ? value.message : typeof error === 'string' ? error : ''
  const code = `${value.code ?? ''} ${value.cause?.code ?? ''}`
  const status = typeof value.status === 'number' ? value.status : undefined
  let kind: SubagentFailureKind = 'unknown'
  if (value.name === 'AgentCompletionError') kind = 'no_deliverable'
  else if (status !== undefined && [401, 403, 404].includes(status)) kind = 'configuration'
  else if (value.name === 'ContextBudgetExceededError' || /context[_ -]?(?:length|window|limit)|maximum context|too many tokens|input.*longer.*context/i.test(message)) kind = 'context_limit'
  else if (status === 429) kind = 'rate_limit'
  else if (status === 408 || status === 504 || value.name === 'TimeoutError' || /TIMEOUT|TIMEDOUT/i.test(code) || /timed? ?out|stream idle timeout/i.test(message)) kind = 'timeout'
  else if (status !== undefined && status >= 500 && status <= 599) kind = 'provider_unavailable'
  else if (status === 400 || status === 422 || /provider is unknown or disabled|provider does not allow subagents|subagents are disabled/i.test(message)) kind = 'configuration'
  else if (/ECONN|EPIPE|ENET|EHOST|EAI_AGAIN|UND_ERR_SOCKET/i.test(code) || /fetch failed|network|socket|net::ERR_/i.test(message)) kind = 'network'
  return { kind, stage, ...(status === undefined ? {} : { http_status: status }) }
}

export interface SubagentRecovery {
  next_action: 'wait' | 'await_permission' | 'review_result' | 'continue_subagent' | 'fix_configuration'
    | 'reduce_context' | 'inspect_failure' | 'respect_cancellation' | 'use_latest_task'
  /** Lifecycle readiness only. Provider settings, file ownership and normal permissions are rechecked on continue. */
  continuation_ready: boolean
  retry_recommended: boolean
  repeated_failure_kind: boolean
}

export function subagentRecovery(status: McpTaskStatus['status'], settled: boolean, latest: boolean,
  failure?: SubagentFailure, previousFailure?: SubagentFailureKind): SubagentRecovery {
  const result: SubagentRecovery = { next_action: 'wait', continuation_ready: false, retry_recommended: false,
    repeated_failure_kind: !!failure && failure.kind === previousFailure }
  if (!latest) return { ...result, next_action: 'use_latest_task' }
  if (status === 'awaiting_permission') return { ...result, next_action: 'await_permission' }
  if (!settled || status === 'running' || status === 'busy') return result
  result.continuation_ready = true
  if (status === 'completed') return { ...result, next_action: 'review_result' }
  if (status === 'aborted') return { ...result, next_action: 'respect_cancellation' }
  if (failure?.kind === 'configuration') return { ...result, next_action: 'fix_configuration' }
  if (failure?.kind === 'context_limit') return { ...result, next_action: 'reduce_context' }
  const transient = failure && ['network', 'timeout', 'rate_limit', 'provider_unavailable', 'no_deliverable'].includes(failure.kind)
  return { ...result, next_action: transient && !result.repeated_failure_kind ? 'continue_subagent' : 'inspect_failure',
    retry_recommended: !!transient && !result.repeated_failure_kind }
}

export function continuationPrompt(prompt: string, previousStatus: McpTaskStatus['status'], originalTask?: string): string {
  return `[Continue the existing child session; previous status: ${previousStatus}]\nKeep the same role, assigned file and acceptance criteria. Read your existing history and current file/artifact state first. Preserve completed changes and avoid repeating commands or external effects that already succeeded. Finish only the remaining work and run focused validation; report unresolved blockers to the parent.\n\n`
    + (originalTask ? `Original task (the prior startup did not establish a running turn):\n${originalTask}\n\n` : '')
    + `Parent continuation instruction:\n${prompt}`
}
