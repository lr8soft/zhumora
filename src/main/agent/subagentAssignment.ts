export type SubagentRole = 'explorer' | 'implementer' | 'reviewer' | 'verifier'

export interface SubagentAssignmentInput {
  role?: SubagentRole
  context?: string
  acceptanceCriteria?: string[]
  validationCommand?: string
  outputFormat?: string
  dependsOn?: string[]
}

export interface SubagentAssignment extends SubagentAssignmentInput {
  objective: string
  dependsOn: string[]
}

const ROLE_GUIDANCE: Record<SubagentRole, string> = {
  explorer: 'Investigate only the assigned question. Do not edit project files. Return evidence with file/symbol references, a concise conclusion and unresolved questions.',
  implementer: 'Implement the agreed small change in exactly one assigned project file. Read surrounding code as needed; do not change adjacent files or redesign interfaces. Return actual changes, focused validation and blockers.',
  reviewer: 'Review only the assigned change or question. Do not edit project files. Return actionable findings with severity, evidence and file/line references; distinguish confirmed defects from uncertainty.',
  verifier: 'Run only the assigned focused checks. Do not edit project files, install dependencies or run autofixes. Report the exact commands, observed results and failures. The parent owns overall integration tests/build.'
}

/** Legacy free-text assignments are normalized only here; role profiles do not filter tools or grant permissions. */
export function normalizeSubagentAssignment(input: { prompt: string; targetFile?: string } & SubagentAssignmentInput): SubagentAssignment | undefined {
  if (input.role !== undefined && (typeof input.role !== 'string' || !Object.hasOwn(ROLE_GUIDANCE, input.role))) throw new Error('Unknown subagent role.')
  if (input.role === 'implementer' && !input.targetFile) throw new Error('The implementer role requires targetFile: one assigned project file.')
  for (const key of ['context', 'validationCommand', 'outputFormat'] as const) {
    const value = input[key]
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new Error(`${key} must be nonempty text.`)
  }
  for (const key of ['acceptanceCriteria', 'dependsOn'] as const) {
    const value = input[key]
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())
      || (key === 'dependsOn' && new Set(value).size !== value.length))) throw new Error(`${key} must contain nonempty${key === 'dependsOn' ? ', unique' : ''} strings.`)
  }
  const size = input.prompt.length + (input.context?.length ?? 0) + (input.validationCommand?.length ?? 0)
    + (input.outputFormat?.length ?? 0) + (input.acceptanceCriteria ?? []).join('').length + (input.dependsOn ?? []).join('').length
  if (size > 24000) throw new Error('Combined subagent work order exceeds 24000 characters.')
  if (['role', 'context', 'acceptanceCriteria', 'validationCommand', 'outputFormat', 'dependsOn'].every(key => input[key as keyof SubagentAssignmentInput] === undefined)) return undefined
  return { objective: input.prompt, role: input.role, context: input.context,
    acceptanceCriteria: input.acceptanceCriteria ? [...input.acceptanceCriteria] : undefined,
    validationCommand: input.validationCommand, outputFormat: input.outputFormat, dependsOn: [...(input.dependsOn ?? [])] }
}

export function subagentRoleGuidance(role?: SubagentRole): string { return role ? ROLE_GUIDANCE[role] : '' }

export function formatSubagentAssignment(assignment: SubagentAssignment): string {
  return [assignment.role ? `Role: ${assignment.role}\n${subagentRoleGuidance(assignment.role)}` : '',
    `Objective:\n${assignment.objective}`, assignment.context ? `Necessary context:\n${assignment.context}` : '',
    assignment.acceptanceCriteria?.length ? `Acceptance criteria:\n${assignment.acceptanceCriteria.map(item => `- ${item}`).join('\n')}` : '',
    assignment.validationCommand ? `Focused validation command:\n${assignment.validationCommand}` : '',
    assignment.outputFormat ? `Expected result format:\n${assignment.outputFormat}` : '',
    assignment.dependsOn.length ? `Completed dependencies: ${assignment.dependsOn.join(', ')}` : '']
    .filter(Boolean).join('\n\n')
}

export function assignmentOwnsFile(assignment?: SubagentAssignment): boolean {
  return !assignment?.role || assignment.role === 'implementer'
}
