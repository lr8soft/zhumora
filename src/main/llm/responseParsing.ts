import type { ChatMessage, ProviderConfig } from '../../shared/types.ts'
import { HttpError } from '../net/retryCore.ts'
import { ProviderStreamError } from './streamErrors.ts'
import type { StreamErrorContext } from './providerErrorDetails.ts'
import { resolveReasoningDialect } from './reasoning.ts'

/** Official OpenAI budgets include hidden reasoning; compatible local servers retain their existing parameter. */
export function outputTokenLimit(provider: Pick<ProviderConfig, 'baseUrl'>, maxTokens: number): Record<string, number> {
  return new URL(provider.baseUrl).hostname === 'api.openai.com'
    ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }
}

/** Preserve reasoning only for its original provider/model or an explicit compatibility choice. */
export function serializeMessages(messages: ChatMessage[], provider: ProviderConfig, model: string, tools: boolean) {
  return messages.map(m => {
    const value: Record<string, unknown> = { role: m.role, content: m.content ?? '' }
    if (m.tool_calls?.length) value.tool_calls = m.tool_calls
    if (m.tool_call_id) value.tool_call_id = m.tool_call_id
    if (m.name) value.name = m.name
    if (canReplayReasoning(m, provider, model, tools)) {
      value.reasoning_content = m.reasoning
    }
    return value
  })
}

export function canReplayReasoning(message: ChatMessage, provider: ProviderConfig, model: string, tools: boolean): boolean {
  const preserve = provider.reasoningHistory === 'preserve' || (provider.reasoningHistory !== 'omit'
    && ((tools && resolveReasoningDialect(provider) === 'deepseek') || /qwen3[._ -]?8/i.test(model)))
  return !!(preserve && message.role === 'assistant' && message.reasoning && (provider.reasoningHistory === 'preserve'
    || (message.reasoningSource?.providerId === provider.id && message.reasoningSource.model === model)))
}

/** Only the effective request projection changes; persisted reasoning remains intact. */
export function projectReasoningHistory(messages: ChatMessage[], provider: ProviderConfig, model: string, tools = true): ChatMessage[] {
  return messages.map(message => {
    if (canReplayReasoning(message, provider, model, tools)) return message
    const { reasoning: _reasoning, reasoningSource: _source, ...rest } = message
    return rest
  })
}

export function parseTextCompletion(json: unknown, context?: StreamErrorContext): string {
  if (!json || typeof json !== 'object') throw new ProviderStreamError('payload', json)
  const body = json as { error?: unknown; choices?: { index?: unknown; message?: { content?: unknown; refusal?: unknown; tool_calls?: unknown[]; function_call?: unknown }; finish_reason?: string }[] }
  if (body.error != null) throw new ProviderStreamError('provider', body.error, context)
  const choice = body.choices?.[0]
  if (!Array.isArray(body.choices) || body.choices.length !== 1 || choice?.finish_reason !== 'stop'
    || (choice.index != null && choice.index !== 0) || choice.message?.function_call != null || choice.message?.refusal
    || choice.message?.tool_calls?.length || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) {
    throw new ProviderStreamError('payload', { reason: 'Auxiliary completion did not deliver a complete text response', response: json })
  }
  return choice.message.content
}

export function retryAfterMilliseconds(headers: Headers, now = Date.now()): number | undefined {
  const rawMs = headers.get('retry-after-ms')
  const raw = headers.get('retry-after')
  const ms = rawMs != null ? Number(rawMs) : raw != null && /^\d+(\.\d+)?$/.test(raw)
    ? Number(raw) * 1000 : raw ? Date.parse(raw) - now : NaN
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 2_147_483_647) : undefined
}

export async function httpResponseError(response: Response): Promise<HttpError> {
  return new HttpError(response.status, 'LLM API ' + response.status + ': ' + await response.text(),
    retryAfterMilliseconds(response.headers))
}
