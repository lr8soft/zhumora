// Single-slot memoization for pure graph projections. Digests capture the observable
// identity of a message array so any projection-affecting field change re-computes,
// while repeated rebuilds over unchanged data (session switches, unrelated updates) hit.

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

function fnv1a(hash: number, text: string): number {
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), FNV_PRIME) >>> 0
  return hash
}

/**
 * Identity of a message array as seen by graph projections: length, ids, tool call counts,
 * statuses, generation state and text sizes. Cached projections capture message object
 * references, so any field a projection renders must change the digest. (A same-length,
 * same-status, same-first/last-char rewrite of one message can slip through and shows up
 * stale for at most one interaction; every surrounding structural change revalidates.)
 */
export function messageDigest(messages: readonly {
  id: string
  sessionId: string
  content?: string
  reasoning?: string
  status?: string
  images?: readonly unknown[] | null
  toolCalls?: readonly unknown[] | null
  generation?: { status?: string; assessmentRevision?: number } | null
}[]): string {
  let hash = fnv1a(FNV_OFFSET, String(messages.length))
  for (const message of messages) {
    hash = Math.imul(hash ^ 0x1e, FNV_PRIME) >>> 0
    hash = fnv1a(hash, message.sessionId)
    hash = fnv1a(hash, message.id)
    hash = fnv1a(hash, String(message.toolCalls?.length ?? 0))
    hash = fnv1a(hash, message.status ?? '')
    hash = fnv1a(hash, `${message.generation?.status ?? ''}:${message.generation?.assessmentRevision ?? ''}`)
    hash = fnv1a(hash, sizeSignature(message.content))
    hash = fnv1a(hash, sizeSignature(message.reasoning))
    hash = fnv1a(hash, String(message.images?.length ?? 0))
  }
  return `${messages.length}:${hash.toString(36)}`
}

function sizeSignature(text: string | undefined): string {
  if (!text || !text.length) return '0'
  return `${text.length}:${text.charCodeAt(0)}.${text.charCodeAt(text.length - 1)}`
}

/** FNV-1a over a string sequence; each value is length-prefixed so ['ab'] ≠ ['a', 'b']. */
export function hashStrings(values: Iterable<string>): string {
  let hash = FNV_OFFSET
  for (const value of values) {
    hash = Math.imul(hash ^ value.length, FNV_PRIME) >>> 0
    hash = fnv1a(hash, value)
  }
  return hash.toString(36)
}

const cache = new Map<string, { key: string; value: unknown }>()

/** Keeps only the latest result per name. Cached values must be treated as read-only; callers must never mutate a returned object. */
export function memoize<T>(name: string, key: string, compute: () => T): T {
  const entry = cache.get(name)
  if (entry && entry.key === key) return entry.value as T
  const value = compute()
  cache.set(name, { key, value })
  return value
}
