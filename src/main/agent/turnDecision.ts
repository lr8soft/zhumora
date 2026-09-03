// ============================================================
// 单轮决策状态机 — 纯函数，无副作用
//
// runAgent 的 while 循环里，streamChat 返回后要在多种终止/恢复
// 路径间做决策（正常完成 / 截断恢复 / 空响应恢复 / 执行工具）。
// 过去这些条件直接内联在循环里，与副作用（落库、push 上下文、
// 计数器）交织，是全项目最难测、最容易改坏的一段。
//
// 这里把"决策"与"执行决策"分离：本函数只根据可观测信号返回下一步
// 动作；副作用由 runner 执行。恢复预算（RecoveryBudget）在调用方推进。
// ============================================================

export interface TurnSignals {
  /** provider 返回的 finish_reason（'stop' | 'length' | 'tool_calls' | ... | 缺失） */
  finishReason: string | undefined
  /** 本轮 streamChat 解析出的工具调用数量 */
  toolCallCount: number
  /** 本轮正文去除首尾空白后是否为空 */
  contentEmpty: boolean
  /** 截断恢复是否还有预算（RecoveryBudget.canRecoverTruncation） */
  canRecoverTruncation: boolean
  /** 空响应恢复是否还有预算（RecoveryBudget.canRecoverEmptyResponse） */
  canRecoverEmptyResponse: boolean
}

export type TurnDecision =
  /** 截断且带工具调用：参数多半不完整，补占位 tool 结果后引导模型拆小步重发 */
  | { kind: 'recover_truncated_tool' }
  /** 截断且为纯文本：追加续写指令继续 */
  | { kind: 'recover_truncated_text' }
  /** 截断但恢复预算耗尽：告知前端后按最终结果收尾 */
  | { kind: 'complete'; truncatedNotice: true }
  /** 空响应（无正文无工具、非截断）：注入继续指令 */
  | { kind: 'recover_empty_response' }
  /** 正常终止：本轮即最终回答 */
  | { kind: 'complete'; truncatedNotice?: undefined }
  /** 有工具调用且未截断：进入工具执行阶段 */
  | { kind: 'execute_tools' }

/** 恢复类决策（执行后 continue 下一轮），与终止/工具执行决策相对 */
export type RecoveryDecision =
  | { kind: 'recover_truncated_tool' }
  | { kind: 'recover_truncated_text' }
  | { kind: 'recover_empty_response' }

/**
 * 决定 streamChat 返回后的下一步。纯函数：相同的信号必得相同的决策。
 * 决策优先级（不可随意调整，逐条对应已知失败模式）：
 *  1. 截断优先于一切 —— 带工具时工具参数不可信，绝不能执行（否则用残缺 JSON 落库）；
 *  2. 截断但预算耗尽 → 收尾，不再重试（防截断死循环烧 token）；
 *  3. 空响应仅在非截断时恢复（截断轮已在上文处理）；
 *  4. 其余有工具调用 → 执行工具；无工具 → 完成。
 */
export function decideTurnOutcome(signals: TurnSignals): TurnDecision {
  const wasTruncated = signals.finishReason === 'length'

  if (wasTruncated && signals.canRecoverTruncation && signals.toolCallCount > 0) {
    return { kind: 'recover_truncated_tool' }
  }

  if (signals.toolCallCount === 0) {
    if (wasTruncated && signals.canRecoverTruncation) {
      return { kind: 'recover_truncated_text' }
    }
    if (wasTruncated) {
      return { kind: 'complete', truncatedNotice: true }
    }
    if (signals.contentEmpty && signals.canRecoverEmptyResponse) {
      return { kind: 'recover_empty_response' }
    }
    return { kind: 'complete' }
  }

  return { kind: 'execute_tools' }
}
