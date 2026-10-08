/** A session remembers both the endpoint and model; model names alone are not unique. */
export interface SessionModelSelection {
  providerId: string
  model: string
}

export function validateSessionModelSelection(value: unknown): SessionModelSelection | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session model selection.')
  const { providerId, model } = value as Record<string, unknown>
  if (typeof providerId !== 'string' || !providerId.trim() || providerId.length > 256
    || typeof model !== 'string' || !model.trim() || model.length > 1024) {
    throw new Error('Invalid session model selection.')
  }
  return { providerId, model }
}
