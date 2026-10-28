import type { ToolHandler } from './registry.ts'
import type { ToolOutputStore } from './toolOutputStore.ts'

export function createToolOutputReader(store: ToolOutputStore): ToolHandler {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'read_tool_output',
        description: 'Read a saved full tool result from this session. Use output_id returned by a tool to inspect omitted output without rerunning it. Follow the returned offset and char_offset cursors, including long lines. Optionally filter by a literal pattern. Saved results expire after seven days.',
        parameters: {
          type: 'object',
          properties: {
            output_id: { type: 'string', description: 'Opaque output_id returned by the original tool.' },
            offset: { type: 'integer', minimum: 1, description: '1-based starting line; default 1.' },
            limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum lines in this page; default 200. Metadata also counts toward the 2000-line output cap.' },
            char_offset: { type: 'integer', minimum: 0, description: '0-based character cursor within the starting line; use the returned cursor for long lines.' },
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
        return { content: await store.read(ctx.sessionId, args.output_id as string, {
          offset: args.offset as number | undefined,
          limit: args.limit as number | undefined,
          char_offset: args.char_offset as number | undefined,
          pattern: args.pattern as string | undefined,
          signal: ctx.signal
        }) }
      } catch (error) {
        if (ctx.signal?.aborted) throw error
        return { content: `Error: ${(error as Error).message}`, isError: true }
      }
    }
  }
}
