export type CompletionFailure = 'empty' | 'length' | 'stream' | 'malformed' | 'unexpected_tools' | 'finish_reason' | 'refused' | 'unverified' | 'limit'

const FAILURE_MESSAGES: Record<CompletionFailure, string> = {
  refused: 'The provider declined or filtered the response.',
  unverified: 'The final response could not be confirmed as complete.',
  limit: 'The agent stopped at its execution limit. The progress summary is not a completed task.',
  empty: 'The model produced no answer or tool call.',
  length: 'The model output was truncated.',
  stream: 'The model stream ended without a complete response.',
  malformed: 'The model returned invalid tool calls.',
  unexpected_tools: 'The model returned tool calls during text-only finalization. These calls were not executed.',
  finish_reason: 'The model did not return a normal final response (finish_reason=stop).'
}

/** Generation failures use SessionService's existing error/cleanup path, never a success callback. */
export class AgentCompletionError extends Error {
  readonly reason: CompletionFailure
  constructor(reason: CompletionFailure, stage: 'response' | 'finalization' = 'response', detail?: string) {
    super(`${stage === 'finalization' ? 'Finalization failed: ' : ''}${FAILURE_MESSAGES[reason]} Completed tool actions are preserved.${detail ? '\n' + detail : ''}`)
    this.name = 'AgentCompletionError'
    this.reason = reason
  }
}
