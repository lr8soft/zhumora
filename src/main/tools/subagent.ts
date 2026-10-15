import type { ToolContext, ToolHandler } from './registry.ts'
import type { ToolExecutionResult } from '../../shared/types.ts'
import type { SubagentScope, SubagentTaskResult } from '../agent/subagentScope.ts'
import type { SubagentRequest } from '../agent/subagentPolicy.ts'

interface SubagentServices {
  getSubagentScope(sessionId: string | undefined, signal: AbortSignal | undefined): SubagentScope
  listSubagentProviders(): { id: string; name: string; defaultModel: string; maxConcurrency: number | null }[]
}

function serialize(value: unknown): ToolExecutionResult { return { content: JSON.stringify(value) } }

function serializeStartup(value: SubagentTaskResult): ToolExecutionResult {
  return { ...serialize(value), isError: value.status === 'failed' || value.status === 'aborted' }
}

export function createSubagentTools(services: SubagentServices): { name: string; handler: ToolHandler }[] {
  const tool = (
    name: string, description: string, properties: object, required: string[], permission: 'safe' | 'normal',
    execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionResult>
  ) => ({
    name,
    handler: {
      permission,
      definition: { type: 'function' as const, function: { name, description,
        parameters: { type: 'object', properties, required, additionalProperties: false } } },
      execute: async (args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> => {
        try { return await execute(args, context) }
        catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true } }
      }
    }
  })
  const scope = (context: ToolContext) => services.getSubagentScope(context.sessionId, context.signal)
  const taskId = (args: Record<string, unknown>): string => {
    if (typeof args.task_id !== 'string' || !args.task_id.trim()) throw new Error('task_id is required.')
    return args.task_id
  }
  const idProperty = { task_id: { type: 'string', description: 'A task_id returned by this parent run.' } }
  const assignmentProperties = {
    role: { type: 'string', enum: ['explorer', 'implementer', 'reviewer', 'verifier'],
      description: 'explorer: one read-only question; implementer: one file change (requires targetFile); reviewer: read-only findings; verifier: focused checks without edits. Profiles guide work; permissions and full tool access remain unchanged.' },
    context: { type: 'string', description: 'Only context needed to finish this task: agreed interfaces, evidence and constraints. Children do not inherit your conversation.' },
    acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Concrete conditions the parent will verify.' },
    validationCommand: { type: 'string', description: 'Focused check for this task; broader integration belongs to the parent. Normal permissions apply.' },
    outputFormat: { type: 'string', description: 'Expected concise result format: changes/findings, evidence, checks actually run and blockers.' },
    dependsOn: { type: 'array', items: { type: 'string' }, uniqueItems: true,
      description: 'Current task IDs owned by this parent run. Every prerequisite must be completed and settled before spawn; otherwise no child is created. Full results remain available through wait_subagents.' }
  }
  return [
    tool('list_subagent_providers', 'List enabled providers allowed for subagents, default models and their configured maxConcurrency. Disallowed providers are excluded. null means unlimited. Limits are shared by all main/subagent and auxiliary LLM requests for that provider. Credentials are never returned.', {}, [], 'safe',
      async () => serialize(services.listSubagentProviders())),
    tool('spawn_subagent', `Proactively delegate a ready independent question, one-file implementation, review or focused check. Select a role and supply a concrete prompt/objective, necessary context and acceptance criteria. Dispatch ready work before waiting; inspect actual results yourself. dependsOn prerequisites must be completed and settled. Returns a task_id immediately; queueing is not failure or completion. Shared workspace; human permissions apply. Use saved child model and provider-configured concurrency; no fixed child-count cap. No nested delegation; unfinished tasks are cancelled when the parent ends.`, {
      ...assignmentProperties,
      description: { type: 'string', maxLength: 120, description: 'Short task title.' },
      prompt: { type: 'string', maxLength: 24000, description: 'One small change or bounded question, necessary context, agreed interfaces, acceptance criteria and focused validation. No broad feature or multi-file refactor.' },
      targetFile: { type: 'string', maxLength: 4096, description: 'For code edits, the one assigned project file (relative to the parent workspace or absolute). Active duplicate ownership is rejected. Omit only for bounded read-only/non-file tasks. This is an ownership contract, not a permissions bypass or filesystem sandbox.' },
      providerId: { type: 'string', description: 'Override only for a user-requested provider. Omit to let the application select from the ordered child model sequence using its priority/spread policy and provider load.' },
      model: { type: 'string', description: 'Override only for a user-requested model. Otherwise use the selected sequence model; with an explicit provider, its first sequence model, parent model or provider default.' }
    }, ['description', 'prompt'], 'normal', async (args, context) => serializeStartup(await scope(context).spawn(args as unknown as SubagentRequest))),
    tool('list_subagents', 'Inspect this parent run’s current task inventory: role, file, dependencies, status, settled, diagnostics and recovery advice. Diagnostics show observed phase, last activity, tool counts and failure kind; silence is not proof of a dead worker. continuation_ready describes lifecycle only; settings/permissions are still enforced. No full replies or credentials. Follow next_cursor pages; use wait_subagents for deliverables. Do not repeatedly poll.', {
      after_task_id: { type: 'string', description: 'Optional next_cursor returned by a prior list page. Omit for the first page.' }
    }, [], 'safe', async (args, context) => {
      if (args.after_task_id !== undefined && (typeof args.after_task_id !== 'string' || !args.after_task_id)) throw new Error('after_task_id must be a nonempty string.')
      return serialize(scope(context).list(args.after_task_id as string | undefined))
    }),
    tool('send_subagent_message', 'Send a small clarification or new evidence to your currently running child. Delivery is queued until a safe turn boundary; it cannot interrupt the current HTTP request/tool or approve permissions. Do not broaden its file/role scope. For settled tasks use continue_subagent.', {
      ...idProperty, message: { type: 'string', maxLength: 12000 }
    }, ['task_id', 'message'], 'normal', async (args, context) => serialize(scope(context).send(taskId(args), args.message as string))),
    tool('wait_subagents', 'Wait for your delegated tasks to finish or require human permission. One deadline covers status and cleanup; wait_ms=0 is an immediate snapshot. Use a positive wait instead of repeated polling. Returns bounded final replies and settled (cleanup complete); an aborted task can have settled=false. Continue only after settled=true. Full history remains in each child session. Cannot approve child permissions. Keep following running tasks before your final answer.', {
      task_ids: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true },
      wait_ms: { type: 'integer', minimum: 0, maximum: 60000, description: 'Wait duration; default 30000.' }
    }, ['task_ids'], 'safe', async (args, context) => serialize(await scope(context).wait(args.task_ids as string[], args.wait_ms as number | undefined))),
    tool('continue_subagent', 'Resume an interrupted/failed child or assign a small correction in its same owned file. Reuses the SAME session/history/provider/model/role/file, returns a NEW task_id. Inspect wait_subagents/list_subagents diagnostics and recovery first; require settled=true and continuation_ready=true. Repair configuration/context problems before retrying; inspect repeated failures rather than looping. Keep completed changes and avoid replaying successful side effects. Completed means the turn ended, not that acceptance passed: verify results and continue unfinished work. Respect explicit cancellation. Provider settings and permissions are rechecked. Use a new task for a different file.', {
      ...idProperty, prompt: { type: 'string', maxLength: 24000 }
    }, ['task_id', 'prompt'], 'normal', async (args, context) => serializeStartup(await scope(context).continue(taskId(args), args.prompt as string))),
    tool('cancel_subagent', 'Cancel only a task owned by this parent run and wait for bounded cleanup. Other child tasks and unrelated sessions continue.',
      idProperty, ['task_id'], 'normal', async (args, context) => serialize(await scope(context).cancel(taskId(args))))
  ]
}
