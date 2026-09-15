import type { ToolExecutionResult, ToolCall } from '../../shared/types'
import type { RegisteredTool, ToolContext } from '../tools/registry'

export type ToolPermissionCheck = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<boolean>

export interface ToolExecutionRequest {
  toolCall: ToolCall
  context: ToolContext
  permissionCheck?: ToolPermissionCheck
  hardStop?: string | null
}

export type ToolExecutionDisposition =
  | 'completed'
  | 'aborted'
  | 'hard-stopped'
  | 'not-found'
  | 'invalid-arguments'
  | 'policy-denied'
  | 'executor-unavailable'
  | 'permission-denied'
  | 'failed'

export interface ToolExecutionOutcome {
  toolName: string
  args?: Record<string, unknown>
  output: ToolExecutionResult
  durationMs: number
  disposition: ToolExecutionDisposition
}

/** Adapter boundary that later sandbox/MCP/browser executors can implement. */
export interface ToolHandlerExecutor {
  execute(
    entry: RegisteredTool,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult>
}
