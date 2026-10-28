import type { ToolHandler } from './registry.ts'
import type { ToolOutputStore } from './toolOutputStore.ts'
import type { UIMessage } from '../../shared/types.ts'
import { readOutputTextPage } from './toolOutputPaging.ts'

export interface ToolOutputReaderOptions { getMessages?: (sessionId: string) => readonly UIMessage[] }

export function createToolOutputReader(store: ToolOutputStore, source: ToolOutputReaderOptions = {}): ToolHandler {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'read_tool_output',
        description: 'Read an original tool result from this session. Use output_id from a tool or list_tool_outputs after compaction, a new turn, or restart. Keep the original output_id while following offset/char_offset cursors. pattern is literal search. Disk snapshots expire after seven days; message: references use retained message history. If unavailable, list results again; never repeat side-effecting actions just to recover logs.',
        parameters: {
          type: 'object',
          properties: {
            output_id: { type: 'string', description: 'Opaque output_id returned by the original tool.' },
            offset: { type: 'integer', minimum: 1, description: '1-based starting line; default 1.' },
            limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum lines in this page; default 200. Metadata also counts toward the 2000-line output cap.' },
            char_offset: { type: 'integer', minimum: 0, description: '0-based UTF-16 character cursor within the starting line; use the returned cursor for long lines.' },
            pattern: { type: 'string', minLength: 1, maxLength: 2000, description: 'Optional literal text: only matching lines are returned. Keep the same pattern while paging.' }
          },
          required: ['output_id'],
          additionalProperties: false
        }
      }
    },
    permission: 'safe',
    async execute(args, ctx) {
      if (!ctx.sessionId) return { content: 'A session is required to read tool output', isError: true }
      try {
        const id = args.output_id
        if (typeof id !== 'string' || !id || id.length > 256) throw new Error('Invalid output_id')
        const options = {
          offset: args.offset as number | undefined,
          limit: args.limit as number | undefined,
          char_offset: args.char_offset as number | undefined,
          pattern: args.pattern as string | undefined,
          signal: ctx.signal
        }
        if (id.startsWith('message:')) {
          const message = source.getMessages?.(ctx.sessionId).find(item => item.id === id.slice(8) && item.role === 'tool' && item.sessionId === ctx.sessionId)
          if (!message) throw new Error('Tool output is unavailable in this session; use list_tool_outputs. Do not repeat side-effecting actions.')
          return { content: `output_id=${id}\n${await readOutputTextPage(message.content, options)}`, outputRef: { id } }
        }
        return { content: await store.read(ctx.sessionId, id, options), outputRef: { id } }
      } catch (error) {
        if (ctx.signal?.aborted) throw error
        return { content: `Error: ${(error as Error).message}`, isError: true }
      }
    }
  }
}
