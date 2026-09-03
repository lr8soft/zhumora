// ============================================================
// 轮次副作用执行 — 把 turnDecision 的决策落到上下文 / 回调 / 工具层
//
// 从 runner 抽出（AGENTS.MD："runner 只保留循环编排；恢复逻辑与
// 主循环解耦"）。这些函数都有副作用，因此与纯决策函数
// （turnDecision.decideTurnOutcome）分开：决策可单测，副作用可审查。
// ============================================================
import type { ChatMessage, ToolCall } from '../../shared/types'
import { log } from '../llm/logger'
import type { ToolContext, ToolRegistry } from '../tools/registry'
import { executeToolCall } from './toolExecutor'
import { LoopDetector, type LoopDetectionConfig } from './loopDetector'
import type { OfficeRoute } from './officeRouting'
import {
  EMPTY_CONTINUE_PROMPT,
  MAX_EMPTY_CONTINUATIONS,
  MAX_TRUNCATION_CONTINUATIONS,
  RecoveryBudget,
  TRUNCATION_CONTINUE_PROMPT,
  TRUNCATION_TOOL_ERROR
} from './recoveryPolicy'
import type { RecoveryDecision } from './turnDecision'
import type { WorkingConversation } from './workingConversation'
import type { AgentEventCallbacks, RoundResult } from './eventCallbacks'

/**
 * 执行恢复类决策（截断工具轮 / 截断文本轮 / 空响应轮）的副作用。
 * 每种恢复都有独立预算（RecoveryBudget），耗尽后 decideTurnOutcome
 * 不再返回本类决策 —— 这里无需再判断上限。
 */
export function applyRecoveryDecision(
  decision: RecoveryDecision,
  result: RoundResult,
  round: number,
  conversation: WorkingConversation,
  allAssistantMessages: ChatMessage[],
  recovery: RecoveryBudget,
  cb: AgentEventCallbacks
): void {
  if (decision.kind === 'recover_truncated_tool') {
    // 截断发生在工具轮：tool_calls 参数 JSON 多半不完整，不能执行。
    // 把截断的 assistant 消息作为真实上下文保留（模型能看到自己写到哪里），
    // 给每个调用补一条解释性 tool 结果 → 下一轮引导模型拆小步重发。
    const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || null, tool_calls: result.toolCalls }
    const truncatedAssistantId = cb.onAssistantMessage?.(result.content, result.toolCalls, result.reasoning || undefined) ?? null
    conversation.append(assistantMsg, truncatedAssistantId)
    allAssistantMessages.push(assistantMsg)

    cb.onTruncated?.('tool')
    const continuation = recovery.recordTruncation()
    log('warn', `Round ${round}: output truncated at token limit (finish_reason=length) — tool call(s) incomplete, asking model to retry with smaller output (continuation ${continuation}/${MAX_TRUNCATION_CONTINUATIONS})`)
    for (const tc of result.toolCalls) {
      cb.onToolCall?.(tc, truncatedAssistantId)
      const persistId = cb.onToolResult?.(tc.id, tc.function.name, TRUNCATION_TOOL_ERROR, true, 0) ?? null
      conversation.append({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: TRUNCATION_TOOL_ERROR }, persistId)
    }
    return
  }

  if (decision.kind === 'recover_truncated_text') {
    // content 为空时不推空 assistant 消息（部分严格后端会拒绝），直接续写
    if (result.content) {
      conversation.append(
        { role: 'assistant', content: result.content },
        cb.onAssistantMessage?.(result.content, [], result.reasoning || undefined) ?? null
      )
      allAssistantMessages.push({ role: 'assistant', content: result.content })
    } else {
      cb.onAssistantMessage?.(result.content, [], result.reasoning || undefined)
    }
    cb.onTruncated?.('text')
    const continuation = recovery.recordTruncation()
    log('warn', `Round ${round}: text output truncated at token limit (finish_reason=length) — continuing (continuation ${continuation}/${MAX_TRUNCATION_CONTINUATIONS})`)
    conversation.appendSyntheticUser(TRUNCATION_CONTINUE_PROMPT)
    return
  }

  // recover_empty_response：空 assistant 消息不落库也不进上下文（部分严格后端
  // 拒绝空 content），只追加 user 继续指令。仍调用 onAssistantMessage 收尾本轮
  // （回调内部不落库，但重置轮次 id、通知前端把本轮流式气泡归位）。
  cb.onAssistantMessage?.(result.content, result.toolCalls, result.reasoning || undefined)
  const continuation = recovery.recordEmptyResponse()
  log('warn', `Round ${round}: empty response (no content, no tool call, finish_reason=${result.finishReason || 'stop'}) — injecting continue prompt (continuation ${continuation}/${MAX_EMPTY_CONTINUATIONS})`)
  conversation.appendSyntheticUser(EMPTY_CONTINUE_PROMPT)
}

export interface ToolPhaseOptions {
  conversation: WorkingConversation
  toolsRegistry: ToolRegistry
  workspacePath: string
  sessionId?: string
  signal?: AbortSignal
  permissionCheck?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  onSessionTitleUpdate?: (sessionId: string, title: string) => void
  loopDetector: LoopDetector
  loopConfig: LoopDetectionConfig
  officeRoute: OfficeRoute | null
  hardStop: string | null
  officeToolAttempted: boolean
  cb: AgentEventCallbacks
}

export interface ToolPhaseResult {
  hardStop: string | null
  officeToolAttempted: boolean
}

/**
 * 执行一轮里的全部工具调用：逐个过权限 / 循环检测，结果写回工作上下文。
 * 用户中止或已硬停时，toolExecutor 会生成占位 tool 结果，保证
 * assistant.tool_calls 与 tool 结果序列始终合法（不可跳过）。
 */
export async function runToolCallPhase(
  toolCalls: ToolCall[],
  assistantPersistId: string | null,
  opts: ToolPhaseOptions
): Promise<ToolPhaseResult> {
  const {
    conversation, toolsRegistry, workspacePath, sessionId, signal, permissionCheck,
    onSessionTitleUpdate, loopDetector, loopConfig, officeRoute, cb
  } = opts
  let { hardStop, officeToolAttempted } = opts

  const toolContext: ToolContext = { workspacePath, sessionId, signal, onSessionTitleUpdate }

  for (const tc of toolCalls) {
    cb.onToolCall?.(tc, assistantPersistId)
    if (officeRoute && tc.function.name === officeRoute.toolName) officeToolAttempted = true

    // 循环检测：工具名 + 参数完全相同地连续调用
    const verdict = loopDetector.inspect(tc.function.name, tc.function.arguments || '', loopConfig)
    if (verdict.kind === 'hard' && !hardStop) {
      hardStop = `Detected ${verdict.count} consecutive identical calls to "${tc.function.name}"`
      log('warn', `Loop detected (hard): ${hardStop} — stopping to avoid a loop`)
    }

    const executed = await executeToolCall({
      toolCall: tc,
      registry: toolsRegistry,
      context: toolContext,
      permissionCheck,
      hardStop,
      loopWarningCount: verdict.kind === 'soft' ? verdict.count : undefined
    })
    const persistId = cb.onToolResult?.(
      tc.id,
      tc.function.name,
      executed.displayContent,
      executed.isError,
      executed.durationMs
    ) ?? null
    conversation.append(executed.llmMessage, persistId)
  }

  return { hardStop, officeToolAttempted }
}
