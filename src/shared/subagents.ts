export const DEFAULT_SUBAGENTS_ENABLED = true

export function normalizeParallelPreference(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new Error('preferParallel must be a boolean.')
  return value
}

export interface SubagentModelSelection { providerId: string; model: string }
export type SubagentDispatch = 'priority' | 'spread'

export function normalizeSubagentModel(value: unknown): SubagentModelSelection | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const valid = (part: unknown): part is string => typeof part === 'string' && !!part.trim() && part.length <= 200
  return valid(raw.providerId) && valid(raw.model) ? { providerId: raw.providerId.trim(), model: raw.model.trim() } : null
}

/** New sequences are strict; legacy single selection is converted only by the settings boundary. */
export function normalizeSubagentModels(value: unknown): SubagentModelSelection[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('subagentModels must be an ordered array.')
  const seen = new Set<string>()
  return value.flatMap(item => {
    const model = normalizeSubagentModel(item)
    if (!model) throw new Error('Each subagent model must specify a provider and model.')
    const key = JSON.stringify([model.providerId, model.model])
    if (seen.has(key)) return []
    seen.add(key)
    return [model]
  })
}

export function normalizeSubagentDispatch(value: unknown): SubagentDispatch {
  if (value === undefined) return 'priority'
  if (value !== 'priority' && value !== 'spread') throw new Error('Invalid subagent dispatch strategy.')
  return value
}

/** Legacy settings keep the previously enabled behavior; malformed values do not grant capability. */
export function normalizeSubagentsEnabled(value: unknown): boolean {
  return value === undefined ? DEFAULT_SUBAGENTS_ENABLED : value === true
}
