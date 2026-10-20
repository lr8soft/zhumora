/** A persisted projection of one generation, never the owner of an Agent run. */
export interface GenerationMetadata {
  version: 1
  status: 'complete' | 'incomplete' | 'refused' | 'checking' | 'unverified' | 'limit'
  providerId?: string
  model?: string
  returnedModel?: string
  responseId?: string
  requestId?: string
  finishReason?: string
  matchedStop?: string | number
  termination?: 'done' | 'eof' | 'tail_error' | 'tail_timeout' | 'aborted' | 'error' | 'timeout'
  rawFrames?: string[]
  traceOmitted?: boolean
  warnings?: string[]
  frameCount?: number
  byteCount?: number
  durationMs?: number
  purpose?: 'agent' | 'finalization' | 'review' | 'auxiliary'
  reason?: string
  assessmentRevision?: number
  reasoningReplay?: boolean
}
