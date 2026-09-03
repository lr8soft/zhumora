/** Sortable process-local identifier used for persisted records and IPC requests. */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
