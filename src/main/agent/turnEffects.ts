// ============================================================
// 轮次副作用执行 — 把 turnDecision 的决策落到上下文 / 回调 / 工具层
//
// 从 runner 抽出（AGENTS.MD："runner 只保留循环编排；恢复逻辑与
// 主循环解耦"）。这些函数都有副作用，因此与纯决策函数
// （turnDecision.decideTurnOutcome）分开：决策可单测，副作用可审查。
// ============================================================
import type { ChatMessage, ToolCall } from '../../shared/types'
import { log } from '../llm/logger.ts'
import type { ToolContext, ToolRegistry } from '../tools/registry'
import { executeToolCall } from './toolExecutor.ts'
import { LoopDetector, type LoopDetectionConfig } from './loopDetector.ts'
import {
  EMPTY_CONTINUE_PROMPT,
  MAX_EMPTY_CONTINUATIONS,
  MAX_TRUNCATION_CONTINUATIONS,
  MALFORMED_TOOL_CONTINUE_PROMPT,
  MALFORMED_TOOL_ERROR,
  RecoveryBudget,
  STREAM_INTERRUPTED_CONTINUE_PROMPT,
  STREAM_INTERRUPTED_TOOL_ERROR,
  TRUNCATION_CONTINUE_PROMPT,
  TRUNCATION_TOOL_ERROR
} from './recoveryPolicy.ts'
import type { IncompleteCause, RecoveryDecision } from './turnDecision'
import type { WorkingConversation } from './workingConversation'
import { markGeneration, roundAssistant } from './roundOutput.ts'
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
  result.generation = markGeneration(result, 'incomplete', result.generation?.reason || decision.kind)
  if (decision.kind === 'recover_truncated_tool') {
    // 原始 assistant + 占位 tool 结果仍完整落库供 UI/诊断查看，但整组不进入
    // 工作上下文。否则残缺 arguments 会在下一请求中让严格后端直接 500。
    persistIncompleteToolRound(result, decision.cause || 'length', allAssistantMessages, cb)
    const continuation = recovery.recordTruncation()
    const label = decision.cause === 'stream'
      ? 'stream interrupted mid-response'
      : decision.cause === 'malformed'
        ? 'invalid tool identity or JSON arguments'
        : 'output truncated at token limit (finish_reason=length)'
    log('warn', `Round ${round}: incomplete tool round (${label}) — tool call(s) not executed, asking model to retry with smaller valid arguments (continuation ${continuation}/${MAX_TRUNCATION_CONTINUATIONS})`)
    conversation.appendSyntheticUser(toolContinuationPrompt(decision.cause || 'length'))
    return
  }

  if (decision.kind === 'recover_truncated_text') {
    const isStream = decision.cause === 'stream'
    const continuePrompt = isStream ? STREAM_INTERRUPTED_CONTINUE_PROMPT : TRUNCATION_CONTINUE_PROMPT
    // content 为空时不推空 assistant 消息（部分严格后端会拒绝），直接续写
    if (result.content) {
      conversation.append(
        roundAssistant(result),
        cb.onAssistantMessage?.(result.content, [], result.reasoning || undefined, result.generation) ?? null
      )
      allAssistantMessages.push({ role: 'assistant', content: result.content })
    } else {
      cb.onAssistantMessage?.(result.content, [], result.reasoning || undefined, result.generation)
    }
    cb.onTruncated?.('text', isStream ? 'stream' : 'length')
    const continuation = recovery.recordTruncation()
    log('warn', `Round ${round}: incomplete text round (${isStream ? 'stream interrupted mid-response' : 'text output truncated at token limit (finish_reason=length)'}) — continuing (continuation ${continuation}/${MAX_TRUNCATION_CONTINUATIONS})`)
    conversation.appendSyntheticUser(continuePrompt)
    return
  }

  // 无正文 assistant 不进工作上下文；真实 reasoning 仍可持久化，完全空的轮次只收尾。
  cb.onAssistantMessage?.(result.content, result.toolCalls, result.reasoning || undefined, result.generation)
  const continuation = recovery.recordEmptyResponse()
  log('warn', `Round ${round}: empty response (no content, no tool call, finish_reason=${result.finishReason || 'stop'}) — injecting continue prompt (continuation ${continuation}/${MAX_EMPTY_CONTINUATIONS})`)
  conversation.appendSyntheticUser(EMPTY_CONTINUE_PROMPT)
}

/**
 * 持久化一个不可执行的工具轮，并为每个调用补齐占位结果。
 * 故意不接收 WorkingConversation：损坏的 arguments 绝不能进入 provider 上下文。
 */
export function persistIncompleteToolRound(
  result: RoundResult,
  cause: IncompleteCause,
  allAssistantMessages: ChatMessage[],
  cb: AgentEventCallbacks
): void {
  const toolError = cause === 'stream'
    ? STREAM_INTERRUPTED_TOOL_ERROR
    : cause === 'malformed' ? MALFORMED_TOOL_ERROR : TRUNCATION_TOOL_ERROR
  persistUnexecutedToolRound(result, toolError, allAssistantMessages, cb)
  cb.onTruncated?.('tool', cause === 'stream' ? 'stream' : 'length')
}

export function persistUnexecutedToolRound(result: RoundResult, toolError: string,
  allAssistantMessages: ChatMessage[], cb: AgentEventCallbacks): void {
  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: result.content || null,
    tool_calls: result.toolCalls
  }
  const assistantId = cb.onAssistantMessage?.(
    result.content,
    result.toolCalls,
    result.reasoning || undefined, result.generation
  ) ?? null
  allAssistantMessages.push(assistantMsg)

  for (const tc of result.toolCalls) {
    cb.onToolCall?.(tc, assistantId)
    cb.onToolResult?.(tc.id, tc.function.name, toolError, true, 0)
  }
}

function toolContinuationPrompt(cause: IncompleteCause): string {
  if (cause === 'stream') return STREAM_INTERRUPTED_CONTINUE_PROMPT
  if (cause === 'malformed') return MALFORMED_TOOL_CONTINUE_PROMPT
  return TRUNCATION_CONTINUE_PROMPT
}

export interface ToolPhaseOptions {
  outputStore?: ToolContext['outputStore']
  conversation: WorkingConversation
  toolsRegistry: ToolRegistry
  workspacePath: string
  sessionId?: string
  signal?: AbortSignal
  permissionCheck?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  onSessionTitleUpdate?: (sessionId: string, title: string) => void
  loopDetector: LoopDetector
  loopConfig: LoopDetectionConfig
  hardStop: string | null
  cb: AgentEventCallbacks
}

export interface ToolPhaseResult {
  hardStop: string | null
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
    onSessionTitleUpdate, loopDetector, loopConfig, cb
  } = opts
  let { hardStop } = opts

  const toolContext: ToolContext = { workspacePath, sessionId, signal, onSessionTitleUpdate, outputStore: opts.outputStore }

  for (const tc of toolCalls) {
    cb.onToolCall?.(tc, assistantPersistId)

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
      executed.durationMs,
      executed.llmMessage.toolOutputRef
    ) ?? null
    if (persistId && !executed.llmMessage.toolOutputRef) executed.llmMessage.toolOutputRef = { id: `message:${persistId}` }
    conversation.append(executed.llmMessage, persistId)
  }

  return { hardStop }
}
