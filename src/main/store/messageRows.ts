import type { UIMessage } from '../../shared/types.ts'

export interface MessageRow {
  id: string; session_id: string; role: UIMessage['role']; content: string | null
  reasoning?: string | null; tool_calls?: string | null; images?: string | null
  tool_call_id?: string; tool_name?: string; timestamp: number; status?: UIMessage['status']
  coordination_parent_id?: string | null; coordination_task_id?: string | null
  generation?: string | null
  output_ref?: string | null
}

function readImages(value?: string | null): string[] | undefined {
  if (!value) return undefined
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : undefined }
  catch { return undefined }
}

/** Stored coordination provenance survives reloads so guidance never becomes a new child task turn. */
export function messageFromRow(row: MessageRow): UIMessage {
  return { id: row.id, sessionId: row.session_id, role: row.role, content: row.content || '',
    reasoning: row.reasoning || undefined, toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    images: readImages(row.images), toolCallId: row.tool_call_id, toolName: row.tool_name,
    timestamp: row.timestamp, status: row.status, generation: readGeneration(row.generation), outputRef: readOutputReference(row.output_ref),
    coordination: row.coordination_parent_id && row.coordination_task_id
      ? { parentSessionId: row.coordination_parent_id, taskId: row.coordination_task_id } : undefined }
}

function readOutputReference(raw?: string | null): UIMessage['outputRef'] {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw)
    return typeof value?.id === 'string' && value.id.length > 0 && value.id.length <= 256 ? { id: value.id } : undefined
  } catch { return undefined }
}

function readGeneration(raw?: string | null): UIMessage['generation'] {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw)
    return value?.version === 1 && ['complete', 'incomplete', 'refused', 'checking', 'unverified', 'limit'].includes(value.status)
      ? value : undefined
  } catch { return undefined }
}
