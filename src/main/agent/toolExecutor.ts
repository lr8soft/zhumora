import type { ChatMessage, ContentPart, ToolCall } from '../../shared/types'
import { log } from '../llm/logger.ts'
import type { ToolContext } from '../tools/registry'
import type { ToolExecutionService } from '../execution/service'

export interface ToolExecutionOptions {
  toolCall: ToolCall
  service: ToolExecutionService
  context: ToolContext
  permissionCheck?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  hardStop?: string | null
  loopWarningCount?: number
}

export interface ExecutedToolCall {
  llmMessage: ChatMessage
  displayContent: string
  isError: boolean
  durationMs: number
}

export async function executeToolCall(options: ToolExecutionOptions): Promise<ExecutedToolCall> {
  const { toolCall, service, context, permissionCheck, hardStop, loopWarningCount } = options
  const name = toolCall.function.name
  const executed = await service.execute({ toolCall, context, permissionCheck, hardStop })
  let resultText = executed.output.content
  const isError = executed.output.isError === true
  let multimodalContent: ContentPart[] | undefined

  if (loopWarningCount && executed.disposition === 'completed') {
    log('warn', `Loop detected (soft): ${loopWarningCount} consecutive identical calls to ${name}`)
    resultText += `\n\n[Loop warning] This exact call to ${name} has now been made ${loopWarningCount} times in a row. Stop repeating it — try a different approach or proceed to the next step.`
  }

  if (!isError && executed.output.attachments?.length) {
    multimodalContent = []
    if (resultText) multimodalContent.push({ type: 'text', text: resultText })
    for (const attachment of executed.output.attachments) {
      multimodalContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${attachment.mediaType};base64,${attachment.base64}`,
          detail: attachment.detail || 'auto'
        }
      })
    }
  }

  const displayContent = multimodalContent
    ? resultText
      ? `${resultText}\n[image attached, sent to LLM for visual analysis]`
      : 'Image captured (sent to LLM for visual analysis)'
    : resultText

  return {
    llmMessage: {
      role: 'tool',
      tool_call_id: toolCall.id,
      name,
      content: multimodalContent ?? resultText
    },
    displayContent,
    isError,
    durationMs: executed.durationMs
  }
}
