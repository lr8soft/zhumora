import type { UIMessage } from '../../shared/types.ts'
import type { ToolHandler } from './registry.ts'
import type { ToolOutputStore } from './toolOutputStore.ts'
import type { ToolOutputReaderOptions } from './toolOutputReader.ts'

interface ResultEntry { output_id: string; tool_name?: string; message_id?: string; created_at: number; preview: string; storage: string; available: boolean }

function historyEntries(messages: readonly UIMessage[], sessionId: string): Map<string, ResultEntry> {
  const entries = new Map<string, ResultEntry>()
  for (const message of messages) {
    if (message.sessionId !== sessionId || message.role !== 'tool' || message.toolName === 'list_tool_outputs') continue
    const id = message.outputRef?.id ?? `message:${message.id}`
    if (!entries.has(id)) entries.set(id, { output_id: id, tool_name: message.toolName, message_id: message.id,
      created_at: message.timestamp, preview: message.content.slice(0, 160), storage: id.startsWith('message:') ? 'history' : 'snapshot', available: id.startsWith('message:') })
  }
  return entries
}

export function createToolOutputLister(store: ToolOutputStore, source: ToolOutputReaderOptions = {}): ToolHandler {
  return {
    definition: { type: 'function', function: { name: 'list_tool_outputs',
      description: 'Find original tool results in this session after earlier messages were summarized, in later turns, or after app restart. Lists stable output_id, source tool/message, date and preview. Use pattern to narrow the list, then read_tool_output with the original ID. Follow next_offset to page; never rerun a side-effecting tool just to recover its output.',
      parameters: { type: 'object', properties: {
        offset: { type: 'integer', minimum: 1, description: '1-based result offset, default 1.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum entries, default 20, max 100. Actual response is also bounded.' },
        pattern: { type: 'string', maxLength: 2000, description: 'Optional literal text matched against ID, source tool/message and preview.' }
      }, additionalProperties: false } } },
    permission: 'safe',
    async execute(args, ctx) {
      if (!ctx.sessionId) return { content: 'A session is required to list tool output', isError: true }
      try {
        ctx.signal?.throwIfAborted()
        const offset = args.offset ?? 1; const limit = args.limit ?? 20
        if (!Number.isSafeInteger(offset) || (offset as number) < 1 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error('Invalid offset/limit')
        if (args.pattern !== undefined && (typeof args.pattern !== 'string' || args.pattern.length > 2000)) throw new Error('Invalid literal pattern')
        const entries = historyEntries(source.getMessages?.(ctx.sessionId) ?? [], ctx.sessionId)
        let storageWarning: string | undefined
        try {
          for (const saved of await store.list(ctx.sessionId)) {
            const old = entries.get(saved.id)
            entries.set(saved.id, { output_id: saved.id, tool_name: old?.tool_name ?? saved.toolName,
              message_id: old?.message_id, created_at: saved.createdAt, preview: saved.label ?? saved.preview, storage: 'snapshot', available: true })
          }
        } catch (error) { storageWarning = `Snapshot listing unavailable: ${(error as Error).message}` }
        const all = [...entries.values()].filter(item => !args.pattern || JSON.stringify(item).includes(args.pattern as string))
          .sort((a, b) => a.created_at - b.created_at || a.output_id.localeCompare(b.output_id))
        const page: ResultEntry[] = []; let length = 0
        for (const item of all.slice((offset as number) - 1, (offset as number) - 1 + (limit as number))) {
          const size = JSON.stringify(item).length
          if (page.length && length + size > 16000) break
          page.push(item); length += size
        }
        const next = (offset as number) - 1 + page.length
        ctx.signal?.throwIfAborted()
        return { content: JSON.stringify({ results: page, total: all.length, has_more: next < all.length,
          ...(next < all.length ? { next_offset: next + 1 } : {}), ...(storageWarning ? { warning: storageWarning } : {}) }) }
      } catch (error) {
        if (ctx.signal?.aborted) throw error
        return { content: `Error: ${(error as Error).message}`, isError: true }
      }
    }
  }
}
