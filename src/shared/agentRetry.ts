export interface AgentRetryStatus {
  failedAttempt: number
  maxRetries: number
  reason?: 'network' | 'provider_busy'
}

export interface AgentRetryEvent extends AgentRetryStatus {
  sessionId: string
}

export function retryMessageKey(status: AgentRetryStatus): 'chat.providerBusy' | 'chat.retrying' {
  return status.reason === 'provider_busy' ? 'chat.providerBusy' : 'chat.retrying'
}
