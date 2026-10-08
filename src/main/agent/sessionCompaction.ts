import type { ProviderConfig } from '../../shared/types.ts'
import type { SessionCompactInfo, SessionServiceDependencies } from './sessionContracts.ts'
import type { SessionEventHub } from './sessionEventHub.ts'
import { mapPersistedHistory } from './messageMapper.ts'
import { buildEffectiveConversation, sanitizeHistoryWithIds } from './history.ts'

interface CompactionContext {
  deps: Pick<SessionServiceDependencies, 'store' | 'fetchContextWindow' | 'planAutoCompact' | 'log'>
  events: SessionEventHub
  now: () => number
}

/** Manual compaction shares the same history/ID mapping and append-only storage boundary as a run. */
export async function compactSession(
  sessionId: string, provider: ProviderConfig, modelOverride: string | undefined, context: CompactionContext
): Promise<SessionCompactInfo> {
  const { deps, events, now } = context
  const history = deps.store.getMessages(sessionId)
  if (history.length < 4) return { beforeTokens: 0, afterTokens: 0, compressedCount: 0, keptCount: history.length }

  const { messages, ids } = mapPersistedHistory(history)
  const sanitized = sanitizeHistoryWithIds(messages, ids)
  const compaction = deps.store.getSessionCompaction(sessionId)
  const built = buildEffectiveConversation(sanitized.messages, sanitized.ids, compaction)
  const effectiveIds: Array<string | null> = built.hasSummary
    ? [null, ...sanitized.ids.slice(built.keptFromIndex)]
    : [...sanitized.ids]
  const contextWindow = await deps.fetchContextWindow(provider, modelOverride)
  const plan = await deps.planAutoCompact(built.effective, provider, modelOverride, contextWindow)
  const info = {
    beforeTokens: plan.beforeTokens,
    afterTokens: plan.afterTokens,
    compressedCount: plan.compressedCount,
    keptCount: plan.keptCount
  }
  if (plan.compressedCount <= 0) return info

  const boundaryMessageId = effectiveIds[plan.keptOffset - 1] || compaction?.upToMessageId || null
  if (!boundaryMessageId || !plan.summary) throw new Error('Summary generation failed. Check the LLM provider settings and try again.')
  deps.store.setSessionCompaction({ sessionId, upToMessageId: boundaryMessageId, summary: plan.summary, createdAt: now() })
  events.publish(sink => sink.compact?.(sessionId, { source: 'manual', boundaryMessageId, ...info }))
  deps.log?.('info', `Manual compact done: sessionId=${sessionId}, boundary=${boundaryMessageId}, ${plan.beforeTokens} → ${plan.afterTokens} tokens`)
  return info
}
