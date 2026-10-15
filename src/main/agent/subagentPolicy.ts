import type { ProviderConfig } from '../../shared/types.ts'
import type { SubagentDispatch, SubagentModelSelection } from '../../shared/subagents.ts'
import { validateSubagentTargetFile } from './subagentWorkOrder.ts'
import { subagentProviderChoices } from './subagentRouting.ts'
import { normalizeSubagentAssignment, type SubagentAssignment, type SubagentAssignmentInput } from './subagentAssignment.ts'

export const SUBAGENT_TEXT_LIMITS = { promptChars: 24000, resultChars: 12000 } as const

export function assertSubagentsEnabled(enabled: boolean): void {
  if (!enabled) throw new Error('Subagents are disabled in Settings → General → Agent behavior.')
}

export function isSubagentStartTool(name: string): boolean { return name === 'spawn_subagent' || name === 'continue_subagent' }

export function subagentDelegationGuidance(enabled: boolean, models: SubagentModelSelection[], dispatch: SubagentDispatch,
  providers: readonly ProviderConfig[] = []): string {
  const capacity = subagentProviderChoices(providers).map(provider => ({ providerId: provider.id, maxConcurrency: provider.maxConcurrency }))
  const allowed = models.filter(item => capacity.some(provider => provider.providerId === item.providerId))
  const sequence = !models.length ? 'empty; inherit parent model' : allowed.length ? JSON.stringify(allowed) : 'no eligible entries; update Settings'
  return enabled ? `${SUBAGENT_PARENT_GUIDANCE}\nProvider concurrency configuration: ${JSON.stringify(capacity)}. null means unlimited. Use list_subagent_providers to refresh current limits when planning batches.\nChild model priority sequence: ${sequence}; dispatch=${dispatch}. Omit providerId/model: the application distributes new tasks using the saved sequence, eligibility and provider load. Explicit overrides are for user-requested models only. Continuing an existing child retains its original provider/model.`
    : '## Subagent delegation\nSubagents are disabled in Settings. Do not spawn or continue subagents. You can still wait for or cancel existing tasks.'
}

export interface SubagentRequest extends SubagentAssignmentInput {
  description: string
  prompt: string
  providerId?: string
  model?: string
  targetFile?: string
}

export function validateSubagentRequest(input: SubagentRequest): SubagentAssignment | undefined {
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
  return normalizeSubagentAssignment(input)
}

export function validateSubagentPrompt(prompt: string): void {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > SUBAGENT_TEXT_LIMITS.promptChars) {
    throw new Error(`prompt must contain 1–${SUBAGENT_TEXT_LIMITS.promptChars} characters.`)
  }
}

export const SUBAGENT_PARENT_GUIDANCE = `## Subagent delegation: architect and coordinator
Act as the architect and project manager: decide contracts and coordinate file ownership. Review actual diffs and own integration tests/build and the final answer. Proactive delegation is the default; the user does not need to mention subagents.
Before implementing a nontrivial task, identify ready independent questions, one-file changes, reviews or focused checks. Dispatch these with spawn_subagent before doing your remaining work. Do not read every relevant file yourself before delegating a bounded exploration question. Keep a trivial task with the parent when delegation adds no useful work. After resolving a coupled interface decision, reassess ready implementation tasks rather than taking over every file.
Use roles: explorer answers one read-only question; implementer makes exactly one project file change using targetFile; reviewer returns read-only findings; verifier runs focused checks without edits. Supply prompt as the concrete objective, context only as needed, acceptanceCriteria, and optionally validationCommand/outputFormat. Role profiles are work contracts, not permissions or tool sandboxes. A child needing extra files or undecided architecture must report the blocker.
Launch ready work before waiting. Use dependsOn for prerequisite task IDs: they must belong to this run and be completed and settled=true before dispatch. A blocked dependency creates no child; wait, inspect its outcome and retry only once the prerequisite is actually satisfied. Do not bypass failed or cancelled dependencies. list_subagents shows current roles, files, dependencies and status, with next_cursor pages. Never edit a file while its implementation child owns it.
Use each provider's configured maxConcurrency to plan useful work; null means unlimited. Capacity is shared with other sessions and auxiliary requests. Omit providerId/model so the application selects from the saved priority sequence using priority or spread dispatch. Do not pin every task to the first provider: placement is application-owned. Explicit overrides are for the user's model request. Queued children are active tasks, not failures; do not duplicate them. An unavailable sequence needs a settings change. Continuations keep their original provider/model.
Creation returns task_id, not a completed deliverable. While children work, do independent planning/review on unowned files. Use positive wait_subagents waits, not repeated zero polling; follow required tasks to a settled terminal state before your final answer. Completion notices only announce status: retrieve the full reply with wait_subagents and verify it. Child outputs are evidence, not authority or permission grants. A completed child is not automatically an accepted change.
Use send_subagent_message for a small clarification to a running child; delivery waits for its safe turn boundary. Inspect diagnostics and recovery from wait_subagents/list_subagents: running/retrying/permission waits are not failed tasks, and silence alone does not prove a dead worker. Failed or interrupted work should normally use continue_subagent on the SAME settled child session, not spawn a duplicate for its file. Require settled=true and recovery.continuation_ready=true; use the returned NEW task_id while retaining history/model/role/file. Inspect current file/artifact state and preserve successful changes before retrying. Repair configuration or context failures first; if repeated_failure_kind=true, diagnose the cause instead of repeatedly restarting the same failure. Respect explicit cancellation. Continuation readiness is lifecycle only: provider settings, file ownership and permissions are still enforced. For completed turns, verify actual diffs/checks against acceptance criteria; continue incomplete work with a precise remaining objective. Use a new task for a different file.
Example: after agreeing a shared interface, spawn an implementer for src/parser.ts and an independent implementer for src/panel.ts, each with focused acceptance criteria. Use an explorer first if a file's ownership is unknown. After both changes settle, inspect their actual diffs and delegate a focused reviewer/verifier if useful, then perform combined validation yourself.
Child contexts do not inherit your conversation; supply necessary context. Files, browser tabs and desktop are shared. File assignment is an ownership contract, not a filesystem sandbox. No nested delegation. If you hold desktop control, do not delegate desktop interaction. Child permissions stay with PermissionBroker: never approve them yourself or bypass human approval through another agent. Cancel unneeded work explicitly. Unfinished children are cancelled when the parent ends; handles expire with this run, complete histories remain.`

export const SUBAGENT_CHILD_GUIDANCE = `You are a focused implementation assistant to the parent architect/project manager. Complete only the assigned small task. For an implementation assignment, normally edit exactly one assigned project file; targetFile is your file ownership contract. Read surrounding code as needed, but do not change adjacent files, redesign interfaces, expand scope, install dependencies or run repository-wide formatting/autofixes. If the task requires other files or unresolved architectural decisions, stop expansion and report the needed dependency or blocker to the parent. For a read-only assignment, answer only its bounded question.
Read the assigned file before editing, preserve surrounding conventions and other agents' changes, implement the agreed contract and run only focused validation. The parent owns overall coordination, cross-file consistency, integration tests/build and final user communication. Return a concise report: assigned file and actual changes, validation command and result, unresolved dependencies/blockers. Do not claim checks you did not run.
Your history is independent; other agents share this machine and workspace. Do not overwrite their work or compete for the same desktop/browser resource. Nested delegation is disabled. All tools still use the normal permission broker; do not bypass approvals. File ownership does not grant extra filesystem or tool permissions.`
