export const DEFAULT_SUBAGENTS_ENABLED = true

export interface SubagentModelSelection { providerId: string; model: string }

export function normalizeSubagentModel(value: unknown): SubagentModelSelection | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const valid = (part: unknown): part is string => typeof part === 'string' && !!part.trim() && part.length <= 200
  return valid(raw.providerId) && valid(raw.model) ? { providerId: raw.providerId.trim(), model: raw.model.trim() } : null
}

/** Legacy settings keep the previously enabled behavior; malformed values do not grant capability. */
export function normalizeSubagentsEnabled(value: unknown): boolean {
  return value === undefined ? DEFAULT_SUBAGENTS_ENABLED : value === true
}
