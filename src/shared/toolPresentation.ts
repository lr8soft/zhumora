import type { ToolCall } from './types'

export function toolPresentationRevision(
  toolCalls: readonly ToolCall[] | undefined,
  revisions: Readonly<Record<string, string>>
): string {
  if (!toolCalls?.length) return ''
  return toolCalls.map(call => revisions[call.id] || '').join('|')
}

/** 链行成员的最小形状：消息 ID + 该轮发起的 tool calls */
export interface ToolCallRevisionMember {
  id: string
  toolCalls: readonly ToolCall[]
}

/**
 * 工具链行（连续纯工具轮聚合成的展示行）的修订标记：
 * 成员序列 + 每个 toolCall 的结果 id/status。用于 React.memo 比较，
 * 保证"节点结果落位 / 状态翻转 / 链尾追加成员"都能触发链行重渲染，
 * 而 token 流式增量（只改消息 content）不会。
 */
export function toolChainRevision(
  members: readonly ToolCallRevisionMember[],
  revisions: Readonly<Record<string, string>>
): string {
  return members.map(member => {
    const calls = (member.toolCalls || []).map(call => revisions[call.id] || '').join('|')
    return `${member.id}:${calls}`
  }).join('¶')
}
