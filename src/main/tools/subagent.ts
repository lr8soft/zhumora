import type { ToolContext, ToolHandler } from './registry.ts'
import type { ToolExecutionResult } from '../../shared/types.ts'
import type { SubagentScope, SubagentTaskResult } from '../agent/subagentScope.ts'
import type { SubagentRequest } from '../agent/subagentPolicy.ts'

interface SubagentServices {
  getSubagentScope(sessionId: string | undefined, signal: AbortSignal | undefined): SubagentScope
  listSubagentProviders(): { id: string; name: string; defaultModel: string }[]
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
    tool('list_subagent_providers', 'List enabled providers and default models for subagent delegation. Credentials are never returned.', {}, [], 'safe',
      async () => serialize(services.listSubagentProviders())),
    tool('spawn_subagent', `Delegate independent work to a new subagent with its own history and optional provider/model. Returns a task_id immediately; running is NOT completion. Spawn independent tasks first, then use wait_subagents until all required tasks finish. Give necessary context, deliverable, and file ownership. Shared files/browser/desktop are not isolated. Human permissions still apply. No nested delegation; 4 concurrent children and 8 turns per parent run. Unfinished children are cancelled when the parent ends.`, {
      description: { type: 'string', maxLength: 120, description: 'Short task title.' },
      prompt: { type: 'string', maxLength: 24000, description: 'Focused task, necessary context, expected deliverable, and resource ownership.' },
      providerId: { type: 'string', description: 'Enabled provider ID from list_subagent_providers; defaults to parent provider.' },
      model: { type: 'string', description: 'Model ID. Defaults to parent model on the same provider, otherwise selected provider default.' }
    }, ['description', 'prompt'], 'normal', async (args, context) => serializeStartup(await scope(context).spawn(args as unknown as SubagentRequest))),
    tool('wait_subagents', 'Wait for your delegated tasks to finish or require human permission. One deadline covers status and cleanup; wait_ms=0 is an immediate snapshot. Use a positive wait instead of repeated polling. Returns bounded final replies and settled (cleanup complete); an aborted task can have settled=false. Continue only after settled=true. Full history remains in each child session. Cannot approve child permissions. Keep following running tasks before your final answer.', {
      task_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, uniqueItems: true },
      wait_ms: { type: 'integer', minimum: 0, maximum: 60000, description: 'Wait duration; default 30000.' }
    }, ['task_ids'], 'safe', async (args, context) => serialize(await scope(context).wait(args.task_ids as string[], args.wait_ms as number | undefined))),
    tool('continue_subagent', 'Assign a follow-up to your completed subagent, preserving its history/provider/model. Returns a NEW task_id immediately. Running children are busy; wait for them first.', {
      ...idProperty, prompt: { type: 'string', maxLength: 24000 }
    }, ['task_id', 'prompt'], 'normal', async (args, context) => serializeStartup(await scope(context).continue(taskId(args), args.prompt as string))),
    tool('cancel_subagent', 'Cancel only a task owned by this parent run and wait for bounded cleanup. Other child tasks and unrelated sessions continue.',
      idProperty, ['task_id'], 'normal', async (args, context) => serialize(await scope(context).cancel(taskId(args))))
  ]
}
