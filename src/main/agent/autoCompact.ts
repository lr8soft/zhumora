// ============================================================
// Auto Compact 编排 — 折叠工作上下文的过期前段
//
// 从 runner 抽出：runner 只负责"何时触发"，这里负责"怎么折叠"。
// 关键不变量（AGENTS.MD）：
// - 压缩只改写发给 LLM 的 effective 上下文，绝不触碰 messages 表；
// - 只有成功生成摘要时才持久化新的 { upToMessageId, summary }；
// - 摘要失败时本次运行退化为截断（不持久化，避免丢失旧摘要）；
// - 压缩边界 = 被折叠的最后一条真实历史消息 id（跳过虚拟摘要位 null）。
// ============================================================
import type { ProviderConfig } from '../../shared/types'
import { planAutoCompact, makeSummaryMessage } from './context'
import type { CompactionState } from './history'
import { log } from '../llm/logger'
import type { WorkingConversation } from './workingConversation'

export interface CompactNotice {
  beforeTokens: number
  afterTokens: number
  compressedCount: number
  keptCount: number
  boundaryMessageId?: string
}

export interface AutoCompactorDeps {
  provider: ProviderConfig
  modelOverride?: string
  contextWindow: number
  /** 成功生成摘要后回传新压缩状态供持久化（不动消息表） */
  persist?: (state: { upToMessageId: string; summary: string }) => void
  /** 通知前端展示压缩提示 */
  onCompact?: (info: CompactNotice) => void
}

export class AutoCompactor {
  private readonly deps: AutoCompactorDeps
  private compactionState: CompactionState | null

  constructor(deps: AutoCompactorDeps, initialCompaction: CompactionState | null) {
    this.deps = deps
    this.compactionState = initialCompaction
  }

  current(): CompactionState | null {
    return this.compactionState
  }

  /**
   * 折叠工作上下文 system 之后的前段。无可折叠的安全边界时 no-op。
   * 成功生成摘要 → 持久化并更新内部状态；失败 → 仅本次运行截断。
   */
  async apply(conversation: WorkingConversation): Promise<void> {
    const effective = conversation.effective()
    const effectiveIds = conversation.effectiveIds()
    const plan = await planAutoCompact(effective, this.deps.provider, this.deps.modelOverride, this.deps.contextWindow)
    if (plan.compressedCount <= 0) {
      log('info', 'Auto compact: no safe boundary to split, skipping')
      return
    }
    // 新边界 = 被折叠的最后一条真实历史消息 id（跳过虚拟摘要位 null）
    const boundaryId = effectiveIds[plan.keptOffset - 1] || this.compactionState?.upToMessageId || null
    if (plan.summary && boundaryId) {
      this.deps.persist?.({ upToMessageId: boundaryId, summary: plan.summary })
      this.compactionState = { upToMessageId: boundaryId, summary: plan.summary }
    }
    // 重建工作上下文：保留 system + (新摘要 + toKeep) 或 (仅 toKeep)
    const tail = plan.summary
      ? [makeSummaryMessage(plan.summary), ...plan.toKeep]
      : plan.toKeep
    const tailIds = plan.summary
      ? [null, ...effectiveIds.slice(plan.keptOffset)]
      : effectiveIds.slice(plan.keptOffset)
    conversation.replaceAfterSystem(tail, tailIds)
    log('warn', plan.summary
      ? `Auto compact: boundary persisted at "${boundaryId}"`
      : 'Auto compact: summary failed, truncated for this run only (state not persisted)')
    this.deps.onCompact?.({
      beforeTokens: plan.beforeTokens,
      afterTokens: plan.afterTokens,
      compressedCount: plan.compressedCount,
      keptCount: plan.keptCount,
      boundaryMessageId: boundaryId || undefined
    })
  }
}
