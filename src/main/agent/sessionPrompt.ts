import type { AppSettings, Session } from '../../shared/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { PromptRuntimeSnapshot } from './promptBuilder.ts'
import { SUBAGENT_CHILD_GUIDANCE, subagentDelegationGuidance } from './subagentPolicy.ts'
import { subagentRoleGuidance, type SubagentRole } from './subagentAssignment.ts'

/** SessionService supplies the role explicitly; tool visibility never implies permission to delegate. */
export function sessionPromptOptions(
  session: Session, settings: AppSettings, tools: ToolRegistry, mcpServers: PromptRuntimeSnapshot['mcpServers'],
  sourcePrompt?: string, commonPrompt?: string, childRole?: SubagentRole, preferParallel = false
) {
  const canDelegate = !session.subagent && !!tools.get('spawn_subagent')
  let systemPromptRole = session.subagent
    ? `You are a focused subagent. Complete the assigned small task and report to the parent. Nested delegation is disabled. ${subagentRoleGuidance(childRole)}`
    : canDelegate && settings.subagentsEnabled
      ? 'You are the lead architect and coordinator of a multi-agent workspace. Proactively delegate ready, independent, small tasks to subagents without waiting for the user to mention subagents. Define contracts, coordinate file ownership, review results and own final integration. Respect provider eligibility, configured child models and human tool permissions.'
      : canDelegate ? 'Subagent delegation is disabled in Settings. Complete the work yourself; do not spawn or continue subagents.' : undefined
  if (canDelegate && settings.subagentsEnabled && preferParallel) {
    systemPromptRole += '\nThe user selected parallel collaboration for this input. Turn the requested work or existing plan into scoped work orders; dispatch ready independent items before implementing the rest yourself. Track dependsOn and inspect all required results. Keep simple/dependent work with the parent; do not create useless agents, bypass permissions or switch forbidden providers.'
  }
  return {
    promptRuntime: { tools: tools.definitions(), builtinTools: tools.definitionsBySource('builtin'),
      mcpTools: tools.definitionsBySource(source => source.startsWith('mcp:')), mcpServers },
    systemPromptRole,
    systemPromptExtra: [sourcePrompt, commonPrompt, session.subagent ? SUBAGENT_CHILD_GUIDANCE
      : canDelegate ? subagentDelegationGuidance(settings.subagentsEnabled, settings.subagentModels, settings.subagentDispatch, settings.providers) : undefined]
      .filter(Boolean).join('\n\n')
  }
}
