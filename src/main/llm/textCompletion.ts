import type { ChatMessage, ProviderConfig } from '../../shared/types.ts'
import { hasValidToolCalls } from '../../shared/toolCalls.ts'
import { createProviderRequestHeaders } from '../../shared/providerHeaders.ts'
import { getFetch } from '../net/fetch'
import { withRetry, getMaxRetries } from '../net/retry'
import { withProviderRequest } from './requestRuntime.ts'
import { shouldRetryProviderError } from './providerRetry.ts'
import { serializeMessages, parseTextCompletion, httpResponseError, outputTokenLimit, retryAfterMilliseconds } from './responseParsing.ts'
import { ProviderStreamError } from './streamErrors.ts'

/** Auxiliary callers receive validated text, never a successful empty/error/truncated result. */
export async function requestTextCompletion(provider: ProviderConfig, messages: ChatMessage[],
  model = provider.defaultModel, maxTokens = 200, signal?: AbortSignal): Promise<string> {
  model = model || provider.defaultModel
  if (messages.some(message => !hasValidToolCalls(message))) throw new Error('LLM request blocked: malformed tool call arguments')
  return withRetry(() => withProviderRequest(provider, signal, async () => {
    const response = await getFetch()(provider.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal, headers: createProviderRequestHeaders(provider),
      body: JSON.stringify({ model, messages: serializeMessages(messages, provider, model, false),
        stream: false, ...outputTokenLimit(provider, maxTokens), temperature: 0.3 })
    })
    if (!response.ok) throw await httpResponseError(response, { provider: provider.name || provider.id, model })
    const responseBody = await response.text()
    const context = { provider: provider.name || provider.id, model, responseBody,
      httpStatus: response.status, retryAfterMs: retryAfterMilliseconds(response.headers),
      requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? response.headers.get('x-generation-id') }
    let payload: unknown
    try { payload = JSON.parse(responseBody) } catch (cause) {
      throw new ProviderStreamError('payload', { reason: 'Invalid JSON completion response', body: responseBody },
        { ...context, envelope: responseBody, cause })
    }
    return parseTextCompletion(payload, context)
  }), { maxRetries: getMaxRetries(), label: 'LLM complete ' + provider.name, signal, shouldRetry: shouldRetryProviderError })
}
