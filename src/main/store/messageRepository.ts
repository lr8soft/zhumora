import type Database from 'better-sqlite3'
import type { UIMessage } from '../../shared/types.ts'
import { messageFromRow, type MessageRow } from './messageRows.ts'

export function insertMessage(database: Database.Database, message: UIMessage): void {
  database.prepare(`INSERT INTO messages
    (id, session_id, role, content, reasoning, tool_calls, tool_call_id, tool_name, images, timestamp, status,
      coordination_parent_id, coordination_task_id, generation, output_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    message.id, message.sessionId, message.role, message.content, message.reasoning || null,
    message.toolCalls ? JSON.stringify(message.toolCalls) : null, message.toolCallId, message.toolName,
    message.images?.length ? JSON.stringify(message.images) : null, message.timestamp, message.status || null,
    message.coordination?.parentSessionId ?? null, message.coordination?.taskId ?? null,
    message.generation ? JSON.stringify(message.generation) : null, message.outputRef ? JSON.stringify(message.outputRef) : null)
}

export function selectMessages(database: Database.Database, sessionId: string): UIMessage[] {
  const rows = database.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC').all(sessionId) as MessageRow[]
  return rows.map(messageFromRow)
}
