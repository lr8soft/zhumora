import type { ChatMessage, ContentPart, ContentPartText } from '../../shared/types.ts'
import { estimateTextTokens } from './contextBudget.ts'

function textOf(content: ChatMessage['content']): string {
  return typeof content === 'string' ? content : content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
}

/**
 * One pointer per projected result. How to use it lives in the tool's own description:
 * repeating those instructions once per result is charged once per result, and under a
 * fan-out of parallel calls that prose alone can exceed the room projection just freed.
 */
const noticeText = (id: string): string => `full output: read_tool_output({"output_id":"${id}"})`

/**
 * Upper bound on one pointer's size, so projection can hold the room back before it
 * chooses a cap and can never truncate the identifier the model needs to recover.
 */
export const RECOVERY_NOTICE_TOKENS = estimateTextTokens(noticeText('out-' + '0'.repeat(64)))

/** Recovery instructions are a separate text part: JSON protocols and image attachments remain intact. */
export async function recoverProjectedToolResults(
  originals: ChatMessage[], projected: ChatMessage[],
  archive: (text: string) => Promise<string>, signal?: AbortSignal
): Promise<ChatMessage[]> {
  const result: ChatMessage[] = []
  for (let index = 0; index < projected.length; index++) {
    signal?.throwIfAborted()
    const message = projected[index]
    const original = originals[index]
    if (message.role !== 'tool' || textOf(message.content) === textOf(original.content)) {
      result.push(message); continue
    }
    const id = original.toolOutputRef?.id ?? await archive(textOf(original.content))
    signal?.throwIfAborted()
    const content: ContentPart[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
      : [...(message.content ?? [])]
    // Only our model-only metadata authorizes replacing the last recovery part.
    if (original.toolOutputRef?.recoveryPart) content.pop()
    const notice: ContentPartText = { type: 'text', text: noticeText(id) }
    result.push({ ...message, content: [...content, notice], toolOutputRef: { id, recoveryPart: true } })
  }
  return result
}
