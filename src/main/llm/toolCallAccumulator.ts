import type { ToolCall } from '../../shared/types.ts'
import { ProviderStreamError } from './streamErrors.ts'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderStreamError('payload', { reason: 'Invalid tool fragment', fragment: value })
  }
  return value as Record<string, unknown>
}

/** Identity is immutable; only function name/arguments are deltas. Never coerce a different tool type. */
export function applyToolDeltas(calls: Map<number, ToolCall>, value: unknown): boolean {
  if (!Array.isArray(value)) throw new ProviderStreamError('payload', value)
  for (const raw of value) {
    const delta = object(raw)
    const index = delta.index
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0
      || (delta.type != null && delta.type !== 'function')
      || (delta.id != null && typeof delta.id !== 'string')) {
      throw new ProviderStreamError('payload', { reason: 'Invalid tool identity', fragment: raw })
    }
    const fn = delta.function == null ? {} : object(delta.function)
    for (const key of ['name', 'arguments']) {
      if (fn[key] != null && typeof fn[key] !== 'string') throw new ProviderStreamError('payload', raw)
    }
    const existing = calls.get(index)
    if (existing?.id && delta.id && existing.id !== delta.id) {
      throw new ProviderStreamError('payload', { reason: 'Tool identity changed within one index', fragment: raw })
    }
    const call = existing ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } }
    if (delta.id) call.id = delta.id as string
    if (fn.name) call.function.name += fn.name
    if (fn.arguments) call.function.arguments += fn.arguments
    calls.set(index, call)
  }
  return value.length > 0
}
