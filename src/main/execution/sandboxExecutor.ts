import type { ToolExecutionResult } from '../../shared/types'
import type { RegisteredTool, ToolContext } from '../tools/registry.ts'
import type { ToolHandlerExecutor } from './contracts.ts'

export interface SandboxRuntimeProfile {
  id: string
  /** Only an OS/container-enforced runtime may claim this value. */
  isolation: 'os-enforced'
}

/** JSON-serializable request crossing into an external sandbox runtime. */
export interface SandboxRuntimeRequest {
  toolId: string
  toolName: string
  toolVersion: string
  capabilities: readonly string[]
  args: Record<string, unknown>
  workspacePath: string
  sessionId?: string
}

export interface SandboxRuntime {
  readonly profile: SandboxRuntimeProfile
  execute(request: SandboxRuntimeRequest, signal?: AbortSignal): Promise<ToolExecutionResult>
}

/**
 * Executor boundary for a real OS/container sandbox. It sends data only; the
 * host ToolHandler is deliberately unreachable from the runtime request.
 */
export class SandboxToolExecutor implements ToolHandlerExecutor {
  private readonly runtime: SandboxRuntime

  constructor(runtime: SandboxRuntime) {
    if (runtime.profile?.isolation !== 'os-enforced' || !runtime.profile.id?.trim()) {
      throw new Error('Sandbox runtime must declare a non-empty id and os-enforced isolation')
    }
    this.runtime = runtime
  }

  async execute(
    entry: RegisteredTool,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    if (entry.manifest.executionClass !== 'sandbox') {
      throw new Error(`Sandbox executor cannot run execution class "${entry.manifest.executionClass}"`)
    }
    if (context.signal?.aborted) throw abortError()

    const output = await this.runtime.execute({
      toolId: entry.manifest.id,
      toolName: entry.manifest.originalName,
      toolVersion: entry.manifest.version,
      capabilities: [...entry.manifest.capabilities],
      args: structuredClone(args),
      workspacePath: context.workspacePath,
      sessionId: context.sessionId
    }, context.signal)

    if (!output || typeof output.content !== 'string') {
      throw new Error(`Sandbox runtime "${this.runtime.profile.id}" returned an invalid tool result`)
    }
    return output
  }
}

function abortError(): Error {
  const error = new Error('Sandbox execution aborted')
  error.name = 'AbortError'
  return error
}
