export interface AgentRetryStatus {
  failedAttempt: number
  maxRetries: number
  reason?: 'network' | 'provider_busy' | 'provider_error'
}

export interface AgentRetryEvent extends AgentRetryStatus {
  sessionId: string
}

export function retryMessageKey(status: AgentRetryStatus): 'chat.providerBusy' | 'chat.retrying' | 'chat.providerErrorRetrying' {
  if (status.reason === 'provider_busy') return 'chat.providerBusy'
  return status.reason === 'provider_error' ? 'chat.providerErrorRetrying' : 'chat.retrying'
}
