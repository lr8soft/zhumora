import type { ToolExecutionResult } from '../../shared/types.ts'
import type { ToolContext } from './registry.ts'
import { BoundedToolOutput, MAX_TOOL_OUTPUT_LINES } from './outputLimits.ts'

/** The original result stays outside the model context; only a genuine omission creates a stored copy. */
export async function recoverableToolOutput(
  text: string,
  context: ToolContext,
  hint: string,
  maxLines = MAX_TOOL_OUTPUT_LINES,
  previewText = text
): Promise<ToolExecutionResult> {
  const output = new BoundedToolOutput(hint, maxLines)
  output.append(previewText)
  const preview = output.snapshot()
  if ((!preview.truncated && previewText === text) || !context.outputStore || !context.sessionId) {
    return { content: preview.text }
  }
  if (context.signal?.aborted) throw new Error('Tool output saving aborted')
  try {
    const id = await context.outputStore.save(context.sessionId, text, context.outputMetadata)
    context.signal?.throwIfAborted()
    return {
      content: `${preview.text}\n[Full output saved. Use read_tool_output with output_id="${id}"; use offset/limit to page, char_offset for long lines, or pattern to search.]`,
      outputRef: { id }
    }
  } catch (error) {
    if (context.signal?.aborted) throw error
    return { content: `${preview.text}\n[Full output could not be saved: ${String((error as Error).message).slice(0, 256)}. Omitted text is unavailable. The operation result is unchanged; do not repeat side-effecting actions to recover output.]` }
  }
}
