import type { ChatMessage, ContentPart, ToolCall } from '../../shared/types'
import { log } from '../llm/logger'
import { normalizeToolOutput, type ToolContext, type ToolRegistry } from '../tools/registry'

export interface ToolExecutionOptions {
  toolCall: ToolCall
  registry: ToolRegistry
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
  const { toolCall, registry, context, permissionCheck, hardStop, loopWarningCount } = options
  const name = toolCall.function.name
  let resultText = ''
  let isError = false
  let durationMs = 0
  let multimodalContent: ContentPart[] | undefined

  if (context.signal?.aborted) {
    resultText = 'Execution skipped: aborted by user'
    isError = true
  } else {
    const entry = registry.get(name)
    if (!entry) {
      resultText = `Error: Tool "${name}" not found`
      isError = true
      log('error', `Tool not found: ${name}`)
    } else {
      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || '{}')
      } catch {
        resultText = `Error: Invalid JSON arguments: ${toolCall.function.arguments}`
        isError = true
      }

      if (!isError && hardStop) {
        resultText = `Execution skipped: agent hard-stopped (${hardStop})`
        isError = true
      }

      if (!isError && permissionCheck && !(await permissionCheck(name, parsedArgs))) {
        resultText = 'Permission denied'
        isError = true
      }

      if (!isError) {
        const start = Date.now()
        try {
          log('info', `Executing tool: ${name}(${JSON.stringify(parsedArgs).slice(0, 200)})`)
          const output = normalizeToolOutput(await entry.handler.execute(parsedArgs, context))
          durationMs = Date.now() - start
          resultText = output.content
          isError = output.isError === true
          log('info', `Tool ${name} completed in ${durationMs}ms`)

          if (loopWarningCount) {
            log('warn', `Loop detected (soft): ${loopWarningCount} consecutive identical calls to ${name}`)
            resultText += `\n\n[Loop warning] This exact call to ${name} has now been made ${loopWarningCount} times in a row. Stop repeating it — try a different approach or proceed to the next step.`
          }

          if (!isError && output.attachments?.length) {
            multimodalContent = []
            if (resultText) multimodalContent.push({ type: 'text', text: resultText })
            for (const attachment of output.attachments) {
              multimodalContent.push({
                type: 'image_url',
                image_url: {
                  url: `data:${attachment.mediaType};base64,${attachment.base64}`,
                  detail: attachment.detail || 'auto'
                }
              })
            }
          }
        } catch (error) {
          durationMs = Date.now() - start
          resultText = `Error: ${(error as Error).message}`
          isError = true
          log('error', `Tool ${name} failed: ${(error as Error).message}`)
        }
      }
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
    durationMs
  }
}
