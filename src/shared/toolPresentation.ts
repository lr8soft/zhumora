import type { ToolCall } from './types'

export function toolPresentationRevision(
  toolCalls: readonly ToolCall[] | undefined,
  revisions: Readonly<Record<string, string>>
): string {
  if (!toolCalls?.length) return ''
  return toolCalls.map(call => revisions[call.id] || '').join('|')
}
