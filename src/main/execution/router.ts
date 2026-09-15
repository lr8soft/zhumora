import type { ToolExecutionResult } from '../../shared/types'
import type { RegisteredTool, ToolContext } from '../tools/registry.ts'
import type { ToolExecutionClass } from '../tools/manifest.ts'
import { CompatibilityToolExecutor } from './compatibilityExecutor.ts'
import type { ToolHandlerExecutor } from './contracts.ts'

export type ToolExecutorRoutes = Partial<Record<ToolExecutionClass, ToolHandlerExecutor>>

export class ToolExecutorUnavailableError extends Error {
  readonly executionClass: ToolExecutionClass

  constructor(executionClass: ToolExecutionClass) {
    super(`No executor is configured for execution class "${executionClass}"`)
    this.name = 'ToolExecutorUnavailableError'
    this.executionClass = executionClass
  }
}

/** Immutable execution-class router. Missing routes fail closed. */
export class ToolExecutionRouter implements ToolHandlerExecutor {
  private readonly routes: ReadonlyMap<ToolExecutionClass, ToolHandlerExecutor>

  constructor(routes: ToolExecutorRoutes) {
    this.routes = new Map(
      Object.entries(routes).filter((entry): entry is [ToolExecutionClass, ToolHandlerExecutor] => Boolean(entry[1]))
    )
  }

  supports(entry: RegisteredTool): boolean {
    return this.routes.has(entry.manifest.executionClass)
  }

  async execute(
    entry: RegisteredTool,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const executor = this.routes.get(entry.manifest.executionClass)
    if (!executor) throw new ToolExecutorUnavailableError(entry.manifest.executionClass)
    return executor.execute(entry, args, context)
  }
}

/**
 * Explicit compatibility routes for current tools. `sandbox` is intentionally
 * absent: declaring that class must never silently execute on the host.
 */
export function createCompatibilityExecutionRouter(
  executor: ToolHandlerExecutor = new CompatibilityToolExecutor()
): ToolExecutionRouter {
  return new ToolExecutionRouter({
    'in-process': executor,
    'host-process': executor,
    mcp: executor,
    browser: executor,
    desktop: executor
  })
}
