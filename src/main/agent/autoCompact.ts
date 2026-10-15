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
import { AgentAbortedError, type ProviderConfig, type ToolDefinition } from '../../shared/types'
import { planAutoCompact, makeSummaryMessage } from './compaction'
import { assertContextFits, estimateTokens, measureContextBudget } from './contextBudget'
import { projectToolResultsToBudget } from './toolResultProjection.ts'
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
  /** 会话中止信号：摘要 LLM 调用的重试循环监听它，用户停止后立即退出 */
  signal?: AbortSignal
  /** 成功生成摘要后回传新压缩状态供持久化（不动消息表） */
  persist?: (state: { upToMessageId: string; summary: string }) => void
  /** 通知前端展示压缩提示 */
  onCompact?: (info: CompactNotice) => void
}

interface AppliedCompaction extends CompactNotice { state: CompactionState | null }

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
   * 超过阈值才折叠（每轮发送前调用；工具结果可能很大，导致逐轮膨胀）。
   * 未超阈值时 no-op。
   */
  async applyIfOverThreshold(
    conversation: WorkingConversation,
    trigger: string,
    tools: ToolDefinition[] = []
  ): Promise<void> {
    this.checkAborted()
    const usage = measureContextBudget(conversation.messages, this.deps.contextWindow, tools)
    log('info', `Context check: request≈${usage.estimatedRequestTokens} / ${usage.threshold} tokens (messages≈${usage.messageTokens}, tools≈${usage.toolDefinitionTokens}, window=${this.deps.contextWindow})`)
    // Fixed system/tools cannot be made smaller by compressing historical messages.
    assertContextFits(conversation.messages.slice(0, 1), this.deps.contextWindow, tools)
    if (usage.estimatedRequestTokens >= usage.threshold) {
      const beforeTokens = estimateTokens(conversation.effective())
      log('info', `Auto compact triggered ${trigger}`)
      const notice = await this.apply(conversation)
      this.checkAborted()
      const projected = projectToolResultsToBudget(conversation.messages, this.deps.contextWindow, tools)
      conversation.replaceAfterSystem(projected.slice(1), conversation.effectiveIds())
      const after = measureContextBudget(conversation.messages, this.deps.contextWindow, tools)
      log('info', `Context recheck: request≈${after.estimatedRequestTokens} / input budget ${after.inputBudget}`)
      // A successful summary alone is not evidence that the full request fits.
      assertContextFits(conversation.messages, this.deps.contextWindow, tools)
      this.checkAborted()
      if (notice?.state) {
        this.deps.persist?.(notice.state)
        this.compactionState = notice.state
      }
      if (notice || after.estimatedRequestTokens < usage.estimatedRequestTokens) {
        this.deps.onCompact?.({ beforeTokens, afterTokens: estimateTokens(conversation.effective()),
          compressedCount: notice?.compressedCount ?? 0, keptCount: conversation.effective().length,
          boundaryMessageId: notice?.boundaryMessageId })
      }
    }
    this.checkAborted()
    assertContextFits(conversation.messages, this.deps.contextWindow, tools)
  }

  private checkAborted(): void {
    if (this.deps.signal?.aborted) throw new AgentAbortedError()
  }

  /**
   * 折叠工作上下文 system 之后的前段。无可折叠的安全边界时 no-op。
   * 成功生成摘要 → 持久化并更新内部状态；失败 → 仅本次运行截断。
   */
  private async apply(conversation: WorkingConversation): Promise<AppliedCompaction | null> {
    const effective = conversation.effective()
    const effectiveIds = conversation.effectiveIds()
    const plan = await planAutoCompact(effective, this.deps.provider, this.deps.modelOverride, this.deps.contextWindow, this.deps.signal)
    if (plan.compressedCount <= 0) {
      log('info', 'Auto compact: no safe boundary to split, skipping')
      return null
    }
    this.checkAborted()
    // 新边界 = 被折叠的最后一条真实历史消息 id（跳过虚拟摘要位 null）
    const boundaryId = effectiveIds.slice(0, plan.keptOffset).reverse().find(id => id !== null)
      || this.compactionState?.upToMessageId || null
    const state = plan.summary && boundaryId ? { upToMessageId: boundaryId, summary: plan.summary } : null
    // 重建工作上下文：保留 system + (新摘要 + toKeep) 或 (仅 toKeep)
    const tail = plan.summary
      ? [makeSummaryMessage(plan.summary), ...plan.toKeep]
      : plan.toKeep
    const tailIds = plan.summary
      ? [null, ...effectiveIds.slice(plan.keptOffset)]
      : effectiveIds.slice(plan.keptOffset)
    conversation.replaceAfterSystem(tail, tailIds)
    log('warn', plan.summary
      ? `Auto compact: boundary candidate "${boundaryId}", awaiting request-budget recheck`
      : 'Auto compact: summary failed, truncated for this run only (state not persisted)')
    return {
      beforeTokens: plan.beforeTokens,
      afterTokens: plan.afterTokens,
      compressedCount: plan.compressedCount,
      keptCount: plan.keptCount,
      boundaryMessageId: state?.upToMessageId,
      state
    }
  }
}
