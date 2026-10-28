import type { ChatMessage, ContentPart, ContentPartText } from '../../shared/types.ts'

function textOf(content: ChatMessage['content']): string {
  return typeof content === 'string' ? content : content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
}

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
    const notice: ContentPartText = { type: 'text', text:
      `Full result: read_tool_output({"output_id":"${id}","offset":1,"limit":200}). Use pattern to search; follow returned cursors to continue.` }
    result.push({ ...message, content: [...content, notice], toolOutputRef: { id, recoveryPart: true } })
  }
  return result
}
