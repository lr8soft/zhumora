import { AgentAbortedError, COMPACT_SUMMARY_PREFIX, type ChatMessage, type ProviderConfig } from '../../shared/types.ts'
import { complete } from '../llm/provider'
import { log } from '../llm/logger'
import { getContextWindow } from './context'
import { estimateMessageTokens, estimateTextTokens, estimateTokens, getPreserveTokenBudget } from './contextBudget.ts'
import { planCompactByTokens } from './history.ts'
import { buildSummaryMessages, SUMMARY_OUTPUT_TOKENS } from './summaryInput.ts'

export interface CompactionPlan {
  summary: string | null
  toKeep: ChatMessage[]
  keptOffset: number
  beforeTokens: number
  afterTokens: number
  compressedCount: number
  keptCount: number
}

async function generateSummary(messages: ChatMessage[], provider: ProviderConfig, model: string | undefined,
  contextWindow: number, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) throw new AgentAbortedError()
  try {
    const prompt = buildSummaryMessages(messages, contextWindow)
    const summary = (await complete(provider, prompt, model, SUMMARY_OUTPUT_TOKENS, signal)).trim()
    if (signal?.aborted) throw new AgentAbortedError()
    // A model exceeding its output cap produces an unusable record; treat it as a
    // failed summary so it is never persisted or sent, instead of poisoning the session.
    if (estimateTextTokens(summary) > SUMMARY_OUTPUT_TOKENS * 2) {
      log('error', `Auto compact: summary ignored (${summary.length} chars exceeds the output budget)`)
      return null
    }
    log('info', `Auto compact: summary generated (${summary.length} chars)`)
    return summary || null
  } catch (error) {
    if (signal?.aborted || error instanceof AgentAbortedError) throw new AgentAbortedError()
    log('error', `Auto compact: summary generation failed: ${(error as Error).message}`)
    return null
  }
}

/** Only plans the historical prefix; recent tool previews belong to the request projection, never storage. */
export async function planAutoCompact(effective: ChatMessage[], provider: ProviderConfig, modelOverride?: string,
  contextWindow?: number, signal?: AbortSignal): Promise<CompactionPlan> {
  if (signal?.aborted) throw new AgentAbortedError()
  const cw = contextWindow && contextWindow > 0 ? contextWindow : getContextWindow(provider, modelOverride)
  const { toCompress, toKeep } = planCompactByTokens(effective, getPreserveTokenBudget(cw), estimateMessageTokens)
  const beforeTokens = estimateTokens(effective)
  if (!toCompress.length) return { summary: null, toKeep: effective, keptOffset: 0, beforeTokens,
    afterTokens: beforeTokens, compressedCount: 0, keptCount: effective.length }
  const summary = await generateSummary(toCompress, provider, modelOverride, cw, signal)
  const afterTokens = estimateTokens(summary ? [makeSummaryMessage(summary), ...toKeep]
    : [makeTruncationNoticeMessage(), ...toKeep])
  log('info', `Auto compact: ${beforeTokens} → ${afterTokens} tokens; retained groups require request-budget recheck`)
  return { summary, toKeep, keptOffset: toCompress.length, beforeTokens, afterTokens,
    compressedCount: toCompress.length, keptCount: toKeep.length }
}

export function makeSummaryMessage(summary: string): ChatMessage {
  return { role: 'user', content: `${COMPACT_SUMMARY_PREFIX}\n${summary}` }
}

// Some OpenAI-compatible backends validate the conversation itself: the Qwen chat
// templates vLLM renders throw "No user query found in messages." (HTTP 400) when no
// message carries role "user". Mid-run agent loops are exactly where truncation can
// fold the only user turn into the discarded prefix, so a summary-less truncation
// must keep the effective conversation sendable with a synthetic user turn.
export const COMPACT_TRUNCATION_NOTICE =
  '[Auto Compact] Earlier conversation turns were truncated to fit the context window, but the summary request failed, so their content is unavailable here. The full history remains available in the session.'

/** Virtual user turn heading a summary-less truncation; never persisted, id = null. */
export function makeTruncationNoticeMessage(): ChatMessage {
  return { role: 'user', content: COMPACT_TRUNCATION_NOTICE }
}
