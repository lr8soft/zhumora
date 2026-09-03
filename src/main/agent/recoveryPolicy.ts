export const MAX_TRUNCATION_CONTINUATIONS = 2
export const MAX_EMPTY_CONTINUATIONS = 2

export const TRUNCATION_TOOL_ERROR =
  '[Output truncated] Your previous response hit the per-response token limit and was cut off: the tool call arguments are incomplete. Re-issue the call with smaller output — e.g. split file writes into multiple smaller chunks — or take the next smaller step.'

export const TRUNCATION_CONTINUE_PROMPT =
  '[System notice] Your previous response was truncated by the per-response token limit (max_tokens) and is incomplete. Continue exactly from where you stopped. Do not repeat what you already wrote. If you were about to call a tool, call it now with a smaller output (split large file writes into chunks).'

export const EMPTY_CONTINUE_PROMPT =
  '[System notice] Your previous response was empty — it contained no text and no tool call. Do not stop now. If the task is already fully complete, write a brief final summary of what you did. Otherwise continue: take the next step by calling a tool or writing your answer.'

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
