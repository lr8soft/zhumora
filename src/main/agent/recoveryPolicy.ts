export const MAX_TRUNCATION_CONTINUATIONS = 2
export const MAX_EMPTY_CONTINUATIONS = 2

export const TRUNCATION_TOOL_ERROR =
  '[Output truncated] Your previous response hit the per-response token limit and was cut off: the tool call arguments are incomplete. Re-issue the call with smaller output — e.g. split file writes into multiple smaller chunks — or take the next smaller step.'

export const TRUNCATION_CONTINUE_PROMPT =
  '[System notice] Your previous response was truncated by the per-response token limit (max_tokens) and is incomplete. Continue exactly from where you stopped. Do not repeat what you already wrote. If you were about to call a tool, call it now with a smaller output (split large file writes into chunks).'

export const EMPTY_CONTINUE_PROMPT =
  '[System notice] Your previous response was empty — it contained no text and no tool call. Do not stop now. If the task is already fully complete, write a brief final summary of what you did. Otherwise continue: take the next step by calling a tool or writing your answer.'

/**
 * 流式响应中途被网络断开（已输出部分内容）时的恢复提示。
 * 与 length 截断共享恢复通路，但成因不同：这里不是输出上限，
 * 是连接在传输途中断了。部分文本已保留在上下文中，引导模型从断点续写。
 */
export const STREAM_INTERRUPTED_TOOL_ERROR =
  '[Stream interrupted] The connection to the model dropped mid-response: the tool call arguments are incomplete. Re-issue the call with smaller output — e.g. split file writes into multiple smaller chunks — or take the next smaller step.'

export const STREAM_INTERRUPTED_CONTINUE_PROMPT =
  '[System notice] The connection to the model dropped mid-response, so your previous output is incomplete. Continue exactly from where you stopped. Do not repeat what you already wrote. If you were about to call a tool, call it now with a smaller output (split large file writes into chunks).'

export const MALFORMED_TOOL_ERROR =
  '[Invalid tool call] The model returned tool arguments that were not a complete JSON object. The call was not executed. Re-issue it with valid JSON and use a smaller call if the arguments are large.'

export const MALFORMED_TOOL_CONTINUE_PROMPT =
  '[System notice] Your previous tool call was not executed because its arguments were not a complete JSON object. Re-issue the call with valid JSON. If the arguments are large, split the work into smaller tool calls.'

/** 流空闲超时（120s 无任何数据，后端疑似挂起）耗尽重试后的续写提示。
 *  与流中断区分：这里连接没有断，是模型侧长时间无响应。 */
export const STREAM_STALLED_TOOL_ERROR =
  '[Stream stalled] The model stopped sending data mid-response: the tool call arguments are incomplete. Re-issue the call with smaller output — e.g. split file writes into multiple smaller chunks — or take the next smaller step.'

export const STREAM_STALLED_CONTINUE_PROMPT =
  '[System notice] The model stopped sending data mid-response (no data for a long time), so your previous output is incomplete. Continue exactly from where you stopped. Do not repeat what you already wrote. If you were about to call a tool, call it now with a smaller output (split large file writes into chunks).'

/** Independent bounded budgets for recovery paths inside one agent run. */
export class RecoveryBudget {
  private truncations = 0
  private emptyResponses = 0

  canRecoverTruncation(): boolean {
    return this.truncations < MAX_TRUNCATION_CONTINUATIONS
  }

  recordTruncation(): number {
    return ++this.truncations
  }

  canRecoverEmptyResponse(): boolean {
    return this.emptyResponses < MAX_EMPTY_CONTINUATIONS
  }

  recordEmptyResponse(): number {
    return ++this.emptyResponses
  }

  resetAfterToolRound(): void {
    this.truncations = 0
    this.emptyResponses = 0
  }
}
