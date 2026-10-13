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
  return [
    tool('list_subagent_providers', 'List enabled providers allowed for subagents, default models and their configured maxConcurrency. Disallowed providers are excluded. null means unlimited. Limits are shared by all main/subagent and auxiliary LLM requests for that provider. Credentials are never returned.', {}, [], 'safe',
      async () => serialize(services.listSubagentProviders())),
    tool('spawn_subagent', `Proactively delegate ready independent work without waiting for the user to mention subagents: normally one small project-file change per child. The parent is the architect/coordinator: define interfaces and acceptance criteria, assign targetFile, review actual diffs and own integration tests/build. Dispatch independent tasks before waiting. Use the selected provider's maxConcurrency from list_subagent_providers to plan parallel batches; null means unlimited. There is no additional fixed child-count or total-task cap. Providers disallowed for subagents are rejected even with an explicit override; no automatic fallback. Returns a task_id immediately; running or provider-capacity queueing is NOT completion. Never assign an entire feature or multi-file refactor to one child. Shared files/browser/desktop are not isolated; do not edit a child's owned file. Human permissions still apply. No nested delegation. Unfinished children are cancelled when the parent ends.`, {
      description: { type: 'string', maxLength: 120, description: 'Short task title.' },
      prompt: { type: 'string', maxLength: 24000, description: 'One small change or bounded question, necessary context, agreed interfaces, acceptance criteria and focused validation. No broad feature or multi-file refactor.' },
      targetFile: { type: 'string', maxLength: 4096, description: 'For code edits, the one assigned project file (relative to the parent workspace or absolute). Active duplicate ownership is rejected. Omit only for bounded read-only/non-file tasks. This is an ownership contract, not a permissions bypass or filesystem sandbox.' },
      providerId: { type: 'string', description: 'Override only when the user explicitly requests a different provider for this task. Omission uses the saved subagent provider, otherwise the parent provider.' },
      model: { type: 'string', description: 'Override only for an explicitly requested model. Omission uses the saved child model when its provider matches; otherwise inherit parent model or selected provider default.' }
    }, ['description', 'prompt'], 'normal', async (args, context) => serializeStartup(await scope(context).spawn(args as unknown as SubagentRequest))),
    tool('wait_subagents', 'Wait for your delegated tasks to finish or require human permission. One deadline covers status and cleanup; wait_ms=0 is an immediate snapshot. Use a positive wait instead of repeated polling. Returns bounded final replies and settled (cleanup complete); an aborted task can have settled=false. Continue only after settled=true. Full history remains in each child session. Cannot approve child permissions. Keep following running tasks before your final answer.', {
      task_ids: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true },
      wait_ms: { type: 'integer', minimum: 0, maximum: 60000, description: 'Wait duration; default 30000.' }
    }, ['task_ids'], 'safe', async (args, context) => serialize(await scope(context).wait(args.task_ids as string[], args.wait_ms as number | undefined))),
    tool('continue_subagent', 'Assign a small correction or follow-up in the same owned file to a settled subagent, preserving history/provider/model/file ownership. Returns a NEW task_id immediately. Wait for settled=true first. Use a new task for a different file; do not broaden a correction into a multi-file feature.', {
      ...idProperty, prompt: { type: 'string', maxLength: 24000 }
    }, ['task_id', 'prompt'], 'normal', async (args, context) => serializeStartup(await scope(context).continue(taskId(args), args.prompt as string))),
    tool('cancel_subagent', 'Cancel only a task owned by this parent run and wait for bounded cleanup. Other child tasks and unrelated sessions continue.',
      idProperty, ['task_id'], 'normal', async (args, context) => serialize(await scope(context).cancel(taskId(args))))
  ]
}
