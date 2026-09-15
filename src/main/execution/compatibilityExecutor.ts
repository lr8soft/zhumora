import { normalizeToolOutput } from '../tools/registry.ts'
import type { ToolExecutionResult } from '../../shared/types'
import type { RegisteredTool, ToolContext } from '../tools/registry.ts'
import type { ToolHandlerExecutor } from './contracts'

/**
 * Transitional executor: preserves the existing in-process handler behavior.
 * Sandboxed and resource-specific executors will replace it by execution class.
 */
export class CompatibilityToolExecutor implements ToolHandlerExecutor {
  async execute(
    entry: RegisteredTool,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    return normalizeToolOutput(await entry.handler.execute(args, context))
  }
}
