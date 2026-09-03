function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  )
}

/** Config list order is presentation-only; identity and field values define semantics. */
export function equivalentConfigList<T extends { id: string }>(left: T[] = [], right: T[] = []): boolean {
  const orderById = (items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id)).map(canonicalize)
  return JSON.stringify(orderById(left)) === JSON.stringify(orderById(right))
}
