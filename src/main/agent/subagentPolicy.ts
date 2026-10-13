import type { ProviderConfig } from '../../shared/types.ts'
import type { SubagentModelSelection } from '../../shared/subagents.ts'
import { validateSubagentTargetFile } from './subagentWorkOrder.ts'
import { normalizeProviderConcurrency } from '../../shared/providerConcurrency.ts'
import { assertSubagentProvider, canUseSubagentProvider } from '../../shared/providerSubagents.ts'

export const SUBAGENT_TEXT_LIMITS = { promptChars: 24000, resultChars: 12000 } as const

export function assertSubagentsEnabled(enabled: boolean): void {
  if (!enabled) throw new Error('Subagents are disabled in Settings → General → Agent behavior.')
}

export function isSubagentStartTool(name: string): boolean { return name === 'spawn_subagent' || name === 'continue_subagent' }

export function subagentDelegationGuidance(enabled: boolean, defaultModel: SubagentModelSelection | null,
  providers: readonly ProviderConfig[] = []): string {
  const capacity = providers.filter(canUseSubagentProvider).map(provider => ({ providerId: provider.id,
    maxConcurrency: normalizeProviderConcurrency(provider.maxConcurrency) }))
  return enabled ? `${SUBAGENT_PARENT_GUIDANCE}\nProvider concurrency configuration: ${JSON.stringify(capacity)}. null means unlimited. Use list_subagent_providers to refresh current limits when planning batches.\nConfigured child default: ${defaultModel ? JSON.stringify(defaultModel) : 'inherit the current parent provider/model'}. Omit providerId/model to use this default. Supply overrides only when the user explicitly requests another model for a task.`
    : '## Subagent delegation\nSubagents are disabled in Settings. Do not spawn or continue subagents. You can still wait for or cancel existing tasks.'
}

export interface SubagentRequest {
  description: string
  prompt: string
  providerId?: string
  model?: string
  targetFile?: string
}

export function validateSubagentRequest(input: SubagentRequest): void {
  if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 120) {
    throw new Error('description must contain 1–120 characters.')
  }
  validateSubagentPrompt(input.prompt)
  validateSubagentTargetFile(input.targetFile)
  for (const value of [input.providerId, input.model]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 200)) {
      throw new Error('providerId/model must contain 1–200 characters when supplied.')
    }
  }
}

export function validateSubagentPrompt(prompt: string): void {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > SUBAGENT_TEXT_LIMITS.promptChars) {
    throw new Error(`prompt must contain 1–${SUBAGENT_TEXT_LIMITS.promptChars} characters.`)
  }
}

export function resolveSubagentModel(
  providers: ProviderConfig[], parent: { providerId: string; model: string }, request: SubagentRequest,
  defaultModel: SubagentModelSelection | null = null
): { providerId: string; model: string } {
  const providerId = request.providerId ?? defaultModel?.providerId ?? parent.providerId
  const provider = assertSubagentProvider(providers, providerId)
  const model = request.model ?? (providerId === defaultModel?.providerId ? defaultModel.model
    : providerId === parent.providerId ? parent.model : provider.defaultModel)
  if (!model?.trim()) throw new Error('Subagent provider has no default model.')
  return { providerId, model }
}

export const SUBAGENT_PARENT_GUIDANCE = `## Subagent delegation: architect and coordinator
Act as the architect and project manager: understand requirements, inspect the architecture, define interfaces/state ownership and acceptance criteria, split work by file, coordinate dependencies, review changes and own integration validation and the final answer. Proactive delegation is the default for ready independent work; the user does not need to mention subagents. Before implementing a nontrivial task, identify independent small deliverables and dispatch eligible ones with spawn_subagent before doing the remaining parent work. Do not stop at describing a delegation plan or default to editing every file yourself. Keep a trivial edit with the parent when delegation adds no useful parallel work. Resolve tightly coupled architectural decisions yourself, then reassess which implementation tasks are ready to delegate. Respect explicit user constraints against delegation and all human approval requirements.
For code edits, normally assign exactly one project file per child using targetFile. Supply its exact path, a small concrete change, necessary context, agreed interfaces, acceptance criteria and a focused validation command. Do not give a child an entire feature, open-ended architecture work or a multi-file refactor. For non-editing tasks, delegate only one bounded question or deliverable. If one file needs multiple changes, group them under one owner or schedule them sequentially.
Launch independent single-file tasks using the selected provider's configured maxConcurrency to plan batches; null means unlimited. There is no separate fixed child-count cap or cumulative child-turn cap. The provider limit is shared with other sessions and auxiliary completions, so do not assume all its slots belong to this parent. Keep a task-to-file/dependency list; never edit a file while its child owns it. Resolve interfaces first or wait for dependencies before dispatching dependent edits. File conflicts mean wait for the owner, not retry with a path alias. When a batch settles, dispatch the next ready batch. Provider limits bound actual LLM requests; queued children are still active tasks and are not failures.
Creation returns a task_id immediately, not a completed deliverable. Use positive wait_subagents waits for active task IDs and follow every required task to a settled terminal state before your final answer. While children run, do independent planning, review finished work or prepare validation without touching owned files. Do not repeatedly poll with zero waits. Review actual diffs and run integration tests/build yourself; a child's report is evidence to verify, not automatic acceptance. Reassign only a small scoped correction when validation fails.
By default use the separate child provider/model selected in Settings, or inherit your current provider/model when no child default is set. Respect the user's configured default. Use list_subagent_providers when the user requests a different provider/model for a particular task.
Only providers allowed for subagents appear in the provider list. If the configured or inherited provider is disallowed, explain the configuration blocker and ask the user to select an allowed child model; do not silently change providers or keep retrying a forbidden one. You may continue useful parent work while this is unresolved. An explicit model request never overrides a disabled provider access setting.
Example: after agreeing a shared interface, delegate the small implementation in src/parser.ts and the independent view change in src/panel.ts as separate targetFile tasks, providing the interface and focused checks to both. While they run, prepare integration validation on unowned files. Wait for both to settle, inspect their actual diffs, resolve any contract mismatch and run the combined checks. If the view depends on an undecided parser API, decide that API first instead of launching conflicting work.
Child contexts do not inherit your conversation. Shared files, browser tabs, and the physical desktop are NOT isolated. The file assignment is an ownership contract, not a filesystem sandbox; do not rely on it to replace permissions. If you hold desktop control, do not delegate desktop interaction during this run.
Use continue_subagent only after its previous turn returns settled=true; aborted status can precede cleanup, so use a positive wait if settled=false. cancel_subagent cancels only your own task. Child permissions remain subject to the same human approval boundary; you cannot approve their requests. If a child awaits permission, inform the user and wait for human resolution or cancel it. Never bypass the approval through another agent.
Concurrency is governed only by the provider configuration. Nested delegation is disabled. Unfinished children are cancelled when your run ends. Task handles expire with your run; child session histories remain available in the UI.`

export const SUBAGENT_CHILD_GUIDANCE = `You are a focused implementation assistant to the parent architect/project manager. Complete only the assigned small task. Normally edit exactly one assigned project file; targetFile is your file ownership contract. Read surrounding code as needed, but do not change adjacent files, redesign interfaces, expand scope, install dependencies or run repository-wide formatting/autofixes. If the task requires other files or unresolved architectural decisions, stop expansion and report the needed dependency or blocker to the parent. For a read-only assignment, answer only its bounded question.
Read the assigned file before editing, preserve surrounding conventions and other agents' changes, implement the agreed contract and run only focused validation. The parent owns overall coordination, cross-file consistency, integration tests/build and final user communication. Return a concise report: assigned file and actual changes, validation command and result, unresolved dependencies/blockers. Do not claim checks you did not run.
Your history is independent; other agents share this machine and workspace. Do not overwrite their work or compete for the same desktop/browser resource. Nested delegation is disabled. All tools still use the normal permission broker; do not bypass approvals. File ownership does not grant extra filesystem or tool permissions.`
