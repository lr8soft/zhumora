import type { ToolExecutionResult } from '../../shared/types'
import type { ToolContext, ToolRegistry } from '../tools/registry'
import type { ToolManifest } from '../tools/manifest.ts'
import { validateToolArguments } from '../tools/schemaValidator.ts'
import {
  ManifestCapabilityPolicy,
  type ToolCapabilityPolicy,
  type ToolCapabilityPolicyDecision
} from './capabilityPolicy.ts'
import {
  createCompatibilityExecutionRouter,
  ToolExecutionRouter,
  ToolExecutorUnavailableError
} from './router.ts'
import type {
  ToolExecutionDisposition,
  ToolExecutionOutcome,
  ToolExecutionRequest
} from './contracts'

export interface ToolExecutionServiceDependencies {
  registry: ToolRegistry
  policy?: ToolCapabilityPolicy
  router?: ToolExecutionRouter
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  now?: () => number
}

/**
 * Single application service for the complete pre/post handler execution path.
 * It owns validation, policy, routing, and permission ordering while the Agent
 * layer remains responsible for tool-call sequencing and message construction.
 */
export class ToolExecutionService {
  private readonly registry: ToolRegistry
  private readonly policy: ToolCapabilityPolicy
  private readonly router: ToolExecutionRouter
  private readonly log: NonNullable<ToolExecutionServiceDependencies['log']>
  private readonly now: () => number

  constructor(deps: ToolExecutionServiceDependencies) {
    this.registry = deps.registry
    this.policy = deps.policy || new ManifestCapabilityPolicy()
    this.router = deps.router || createCompatibilityExecutionRouter()
    this.log = deps.log || (() => {})
    this.now = deps.now || Date.now
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    const name = request.toolCall.function.name
    if (request.context.signal?.aborted) return failure(name, 'aborted', 'Execution skipped: aborted by user')

    const entry = this.registry.get(name)
    if (!entry) {
      this.log('error', `Tool not found: ${name}`)
      return failure(name, 'not-found', `Error: Tool "${name}" not found`)
    }

    const parsed = parseArguments(request.toolCall.function.arguments)
    if (!parsed.args) return failure(name, 'invalid-arguments', parsed.error!)

    const validation = validateToolArguments(entry.manifest.inputSchema, parsed.args)
    if (!validation.valid) {
      return failure(name, 'invalid-arguments', formatValidationError(name, validation.issues), parsed.args)
    }

    if (request.hardStop) {
      return failure(name, 'hard-stopped', `Execution skipped: agent hard-stopped (${request.hardStop})`, parsed.args)
    }

    const policyDecision = await this.evaluatePolicy(entry.manifest, parsed.args, request.context)
    if (!policyDecision.allowed) {
      const reason = policyDecision.reason || 'denied without a reason'
      this.log('warn', `Tool ${name} denied by capability policy: ${reason}`)
      return failure(name, 'policy-denied', `Execution denied by capability policy: ${reason}`, parsed.args)
    }

    // A policy may become asynchronous later. Preserve the same cancellation
    // invariant as permission presentation before proceeding to any side effect.
    if (request.context.signal?.aborted) {
      return failure(name, 'aborted', 'Execution skipped: aborted by user', parsed.args)
    }

    if (!this.router.supports(entry)) {
      const reason = `No executor is configured for execution class "${entry.manifest.executionClass}"`
      this.log('error', `Tool ${name} cannot be routed: ${reason}`)
      return failure(name, 'executor-unavailable', `Execution unavailable: ${reason}`, parsed.args)
    }

    if (request.permissionCheck && !(await request.permissionCheck(name, parsed.args))) {
      return failure(name, 'permission-denied', 'Permission denied', parsed.args)
    }

    // Approval may have waited on a remote presenter. A late approval must not
    // start the tool after the session has already been aborted.
    if (request.context.signal?.aborted) {
      return failure(name, 'aborted', 'Execution skipped: aborted by user', parsed.args)
    }

    const start = this.now()
    try {
      this.log('info', `Executing tool: ${name} [${entry.manifest.executionClass}]`)
      const output = await this.router.execute(entry, parsed.args, request.context)
      const durationMs = Math.max(0, this.now() - start)
      this.log('info', `Tool ${name} completed in ${durationMs}ms`)
      return {
        toolName: name,
        args: parsed.args,
        output,
        durationMs,
        disposition: output.isError === true ? 'failed' : 'completed'
      }
    } catch (error) {
      const durationMs = Math.max(0, this.now() - start)
      const message = error instanceof Error ? error.message : String(error)
      this.log('error', `Tool ${name} failed: ${message}`)
      if (error instanceof ToolExecutorUnavailableError) {
        return failure(name, 'executor-unavailable', `Execution unavailable: ${message}`, parsed.args, durationMs)
      }
      return failure(name, 'failed', `Error: ${message}`, parsed.args, durationMs)
    }
  }

  private async evaluatePolicy(
    manifest: ToolManifest,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolCapabilityPolicyDecision> {
    try {
      const decision = await this.policy.evaluate({ manifest, args, context })
      if (!decision || typeof decision.allowed !== 'boolean') {
        return { allowed: false, reason: 'policy returned an invalid decision' }
      }
      return decision
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log('error', `Capability policy failed closed for ${manifest.name}: ${message}`)
      return { allowed: false, reason: `policy evaluation failed: ${message}` }
    }
  }
}

function parseArguments(raw: string): { args?: Record<string, unknown>; error?: string } {
  let value: unknown
  try {
    value = JSON.parse(raw || '{}')
  } catch {
    return { error: `Error: Invalid JSON arguments: ${raw.slice(0, 500)}` }
  }
  if (!isRecord(value)) return { error: 'Error: Tool arguments must be a JSON object' }
  return { args: value }
}

function formatValidationError(
  toolName: string,
  issues: Array<{ path: string; keyword: string; message: string }>
): string {
  const details = issues.slice(0, 8).map(issue => `${issue.path}: ${issue.message} (${issue.keyword})`)
  if (issues.length > details.length) details.push(`... and ${issues.length - details.length} more issue(s)`)
  return `Error: Invalid arguments for tool "${toolName}":\n${details.join('\n')}`
}

function failure(
  toolName: string,
  disposition: Exclude<ToolExecutionDisposition, 'completed'>,
  content: string,
  args?: Record<string, unknown>,
  durationMs = 0
): ToolExecutionOutcome {
  const output: ToolExecutionResult = { content, isError: true }
  return { toolName, args, output, durationMs, disposition }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
