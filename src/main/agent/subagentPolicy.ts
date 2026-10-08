import type { ProviderConfig } from '../../shared/types.ts'

export const SUBAGENT_LIMITS = { concurrent: 4, turns: 8, promptChars: 24000, resultChars: 12000 } as const

export interface SubagentRequest {
  description: string
  prompt: string
  providerId?: string
  model?: string
}

export function validateSubagentRequest(input: SubagentRequest): void {
  if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 120) {
    throw new Error('description must contain 1–120 characters.')
  }
  validateSubagentPrompt(input.prompt)
  for (const value of [input.providerId, input.model]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 200)) {
      throw new Error('providerId/model must contain 1–200 characters when supplied.')
    }
  }
}

export function validateSubagentPrompt(prompt: string): void {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > SUBAGENT_LIMITS.promptChars) {
    throw new Error(`prompt must contain 1–${SUBAGENT_LIMITS.promptChars} characters.`)
  }
}

export function resolveSubagentModel(
  providers: ProviderConfig[], parent: { providerId: string; model: string }, request: SubagentRequest
): { providerId: string; model: string } {
  const providerId = request.providerId ?? parent.providerId
  const provider = providers.find(item => item.id === providerId && item.enabled)
  if (!provider) throw new Error('Subagent provider is unknown or disabled. Use list_subagent_providers.')
  const model = request.model ?? (providerId === parent.providerId ? parent.model : provider.defaultModel)
  if (!model?.trim()) throw new Error('Subagent provider has no default model.')
  return { providerId, model }
}

export const SUBAGENT_PARENT_GUIDANCE = `## Subagent delegation
You may proactively delegate independent, bounded work using spawn_subagent. Use list_subagent_providers to choose an enabled provider/model when needed; omission inherits your current provider/model.
Spawn all independent tasks before waiting: creation returns a task_id immediately, not a completed deliverable. Use wait_subagents with all task IDs and follow every required task to completed/failed/aborted before your final answer. Do not treat running as success or repeatedly poll with zero waits.
Give each subagent a specific question, necessary context, expected deliverable, and ownership of files/resources. Child contexts do not inherit your conversation. Shared files, browser tabs, and the physical desktop are NOT isolated; avoid concurrent writes to the same resources. If you hold desktop control, do not delegate desktop interaction during this run.
Use continue_subagent only after its previous turn returns settled=true; aborted status can precede cleanup, so use a positive wait if settled=false. cancel_subagent cancels only your own task. Child permissions remain subject to the same human approval boundary; you cannot approve their requests. If a child awaits permission, inform the user and wait for human resolution or cancel it. Never bypass the approval through another agent.
Limits: 4 simultaneous child runs, 8 child turns per parent run, no nested delegation. Unfinished children are cancelled when your run ends. Task handles expire with your run; child session histories remain available in the UI.`

export const SUBAGENT_CHILD_GUIDANCE = `You are a delegated Zhumora subagent. Complete only the assigned task and return a concise report with findings, changed files, validation, and any blockers. Your history is independent; other agents share this machine and workspace. Do not overwrite their work or compete for the same desktop/browser resource. Nested delegation is disabled. All tools still use the normal permission broker; do not bypass approvals.`
