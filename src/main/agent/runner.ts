// ============================================================
// Agent 调度器 — ReAct 工具调用循环（循环编排层）
// 核心流程: 用户输入 → LLM → (tool_calls? → 执行工具 → 回传结果 → LLM)* → 最终回答
//
// 职责边界（AGENTS.MD："runner 只保留循环编排"）：
// - 本文件：轮次循环、终止/恢复决策的副作用执行、收尾调用。
// - 决策本身：turnDecision.decideTurnOutcome（纯状态机，可单测）。
// - 工作上下文与 id 对齐：workingConversation.WorkingConversation。
// - 上下文压缩编排：autoCompact.AutoCompactor（压缩只折叠 effective 上下文，
//   数据库与用户可见历史不受影响；新压缩状态经 onAutoCompact 持久化）。
// - 工具执行 / 权限 / 附件协议：toolExecutor.executeToolCall。
// - 恢复预算：recoveryPolicy.RecoveryBudget。
// ============================================================
import type { ChatMessage, ProviderConfig, ReasoningEffort } from '../../shared/types'
import { streamChat } from '../llm/provider'
import { toReasoningParam, type ReasoningEffortParam } from '../llm/reasoning'
import { log } from '../llm/logger'
import { toolRegistry, type ToolRegistry } from '../tools/registry'
import { buildMemoryPrompt, captureMemories } from '../memory/manager'
import { fetchContextWindow } from '../agent/context'
import { buildSystemPrompt, type PromptRuntimeSnapshot } from '../agent/promptBuilder'
import { buildEffectiveConversation, sanitizeHistoryWithIds, type CompactionState } from './history'
import { extractTextContent } from '../../shared/multimodal'
import { LoopDetector, DEFAULT_LOOP_CONFIG, type LoopDetectionConfig } from './loopDetector'
import { AgentAbortedError } from '../../shared/types'
import { hasValidToolCalls } from '../../shared/toolCalls'
import { MAX_EMPTY_CONTINUATIONS, MAX_TRUNCATION_CONTINUATIONS, RecoveryBudget } from './recoveryPolicy'
import { WorkingConversation } from './workingConversation'
import { AutoCompactor } from './autoCompact'
import { finalizeRun } from './finalizeRun'
import { decideTurnOutcome } from './turnDecision'
import { applyRecoveryDecision, runToolCallPhase, type ToolPhaseOptions } from './turnEffects'
import { SESSION_TITLE_REMINDER } from '../../shared/sessionTitle'
import type { AgentEventCallbacks, RoundResult } from './eventCallbacks'
import { completeTurn, failTurn } from './completeTurn.ts'
import { appendCoordinationMessages, type CoordinationMessage } from './runInbox.ts'

export { MAX_EMPTY_CONTINUATIONS, MAX_TRUNCATION_CONTINUATIONS } from './recoveryPolicy'
// 回调契约定义在 eventCallbacks；runner 是其主要消费者，从这里再导出以兼容既有引用
export type { AgentEventCallbacks } from './eventCallbacks'

export const DEFAULT_MAX_TOOL_ROUNDS = 20

export interface AgentRunOptions {
  /** 完整会话历史（无 system，按时间升序） */
  messages: ChatMessage[]
  /** 与 messages 平行对齐的 UI 消息 id（压缩边界定位用） */
  messageIds: string[]
  /** 已有的压缩记录（无则 null） */
  compaction: CompactionState | null
  provider: ProviderConfig
  workspacePath: string
  sessionId?: string
  /** 权限回调：返回 true 允许执行。决策逻辑由调用方实现（结合三档批准模式 approveMode 和工具权限等级） */
  permissionCheck?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  signal?: AbortSignal
  systemPromptExtra?: string
  systemPromptRole?: string
  /** SessionService delivers queued guidance and child notices only at valid turn boundaries. */
  takeCoordinationMessages?: (finalizing?: boolean) => CoordinationMessage[]
  /** 由组合根提供的已加载 Skill 提示词，runner 不读取模块级全局状态。 */
  skillsPrompt?: string
  /** 构建系统提示词所需的运行时快照，避免 prompt builder 反向依赖 MCP/registry。 */
  promptRuntime?: PromptRuntimeSnapshot
  /** 应用组合根构造的工具注册表；测试可传隔离实例。 */
  toolRegistry?: ToolRegistry
  /** 覆盖模型名（如果用户在聊天页选了别的模型） */
  modelOverride?: string
  /** 对话级思考强度（聊天输入框选择）。undefined = provider 未开启该功能开关，不发送参数 */
  reasoningEffort?: ReasoningEffort
  /** 是否启用长期记忆（提取 + 注入） */
  memoryEnabled?: boolean
  /** 最大工具轮数（0 = 不限制）；不传则读设置 maxRounds，默认 20 */
  maxRounds?: number
  /** 循环检测阈值（默认 soft=3 / hard=5） */
  loopConfig?: LoopDetectionConfig
  /** 会话标题更新回调（由 IPC 层注入） */
  onSessionTitleUpdate?: (sessionId: string, title: string) => void
  /** 会话仍是默认标题 → 系统提示词注入命名提醒（每轮运行都注入，直到标题被设置） */
  sessionNeedsTitle?: boolean
  /**
   * 运行中触发 auto compact 且成功生成摘要时回传新压缩状态（由 IPC 层持久化）。
   * 只折叠 effective 上下文，不触碰数据库中的完整历史。
   */
  onAutoCompact?: (state: { upToMessageId: string; summary: string }) => void
}

/**
 * 运行一次完整的 Agent 对话
 */
export async function runAgent(
  opts: AgentRunOptions,
  cb: AgentEventCallbacks
): Promise<ChatMessage[]> {
  const { provider, workspacePath, messages, messageIds, compaction, signal, sessionId, memoryEnabled, onSessionTitleUpdate } = opts
  const toolsRegistry = opts.toolRegistry || toolRegistry
  // 对话级档位 → 线上参数（'off' → 'none' 显式关闭思考；undefined 才是不发送）。
  // 映射是纯函数，见 llm/reasoning.ts。
  const reasoningEffort = toReasoningParam(opts.reasoningEffort)

  const conversation = buildWorkingConversation(opts)
  const contextWindow = await fetchContextWindow(provider, opts.modelOverride)
  log('info', `Context window: ${contextWindow} tokens`)

  const compactor = new AutoCompactor({
    provider,
    modelOverride: opts.modelOverride,
    contextWindow,
    persist: opts.onAutoCompact,
    signal,
    onCompact: (info) => cb.onCompact?.(info)
  }, compaction)

  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_TOOL_ROUNDS
  const loopConfig = opts.loopConfig || DEFAULT_LOOP_CONFIG
  const loopDetector = new LoopDetector()
  const recovery = new RecoveryBudget()
  /** 硬停原因（循环检测 / 达到轮数上限）；非 null 时本轮剩余工具跳过，循环结束后触发优雅收尾 */
  let hardStop: string | null = null
  const allAssistantMessages: ChatMessage[] = []

  // 复用静态依赖；每轮 hardStop 仍由循环持有并同步。
  const toolPhaseBase: Omit<ToolPhaseOptions, 'hardStop'> = {
    conversation, toolsRegistry, workspacePath, sessionId, signal,
    permissionCheck: opts.permissionCheck, onSessionTitleUpdate, loopDetector, loopConfig, cb
  }

  let round = 0
  while (!hardStop && (maxRounds <= 0 || round < maxRounds)) {
    round++
    log('info', `Agent round ${round} — sending ${conversation.messages.length} messages to LLM`)

    // 轮间中止检查优先于压缩：用户已中止时不再发起摘要 LLM 调用
    if (signal?.aborted) throw new AgentAbortedError()
    appendCoordinationMessages(conversation, opts.takeCoordinationMessages?.() ?? [])
    // 每个工具只负责自身契约与执行。Runner 统一暴露注册表快照，
    // 不允许某个领域工具通过意图识别裁剪其他内置工具或 MCP。
    const tools = toolsRegistry.definitions()
    // round=1 的检查即"发送前检查"，后续轮检查工具结果带来的膨胀。
    // 工具 schema 同样占请求 token，必须纳入预算。
    await compactor.applyIfOverThreshold(conversation, `at round ${round}`, tools)

    const result = await streamRound(conversation, provider, opts.modelOverride, reasoningEffort, tools, signal, cb)
    if (result.usage) cb.onTokenUsage?.(result.usage, opts.modelOverride || provider.defaultModel)

    // 中止检查：provider 层对"用户中止"按部分内容正常返回（不抛错）。
    // 若不在此拦截，agent 会把部分回复当完整结果、继续执行工具调用。
    // 先落盘已生成的部分文本，再抛中止错误（IPC 层据此通知前端该会话已停止）。
    if (signal?.aborted) {
      if (result.content || result.reasoning) cb.onAssistantMessage?.(result.content, [], result.reasoning || undefined)
      throw new AgentAbortedError()
    }

    // 纯状态机先裁决响应；失败不进入任何完成或协作续跑分支。
    const decision = decideTurnOutcome({
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls.length,
      toolCallsValid: hasValidToolCalls({ role: 'assistant', content: result.content, tool_calls: result.toolCalls }),
      contentEmpty: !result.content.trim(),
      streamInterrupted: result.streamInterrupted,
      canRecoverTruncation: recovery.canRecoverTruncation(),
      canRecoverEmptyResponse: recovery.canRecoverEmptyResponse()
    })

    if (decision.kind === 'fail') failTurn(decision.cause, result, allAssistantMessages, cb)

    // 恢复类决策（截断工具轮 / 截断文本轮 / 空响应轮）执行完即进入下一轮
    if (decision.kind !== 'complete' && decision.kind !== 'execute_tools') {
      applyRecoveryDecision(decision, result, round, conversation, allAssistantMessages, recovery, cb)
      continue
    }

    if (decision.kind === 'complete') {
      if (!completeTurn(result, round, { conversation, allAssistantMessages, cb,
        takeCoordinationMessages: opts.takeCoordinationMessages })) continue
      return finishRun(allAssistantMessages, conversation, provider, memoryEnabled, sessionId, cb)
    }

    // 落库并拿到持久化 id（IPC 回调内部写 DB；未落库返回 null）
    const assistantPersistId = cb.onAssistantMessage?.(result.content, result.toolCalls, result.reasoning || undefined) ?? null
    // 新的原始工具轮 → 重置截断恢复计数（上一轮截断已被正常消化）
    recovery.resetAfterToolRound()

    // 记录 assistant 消息（含 tool_calls）到工作上下文。
    // 对应 id = 落库 id（无则 null），保证压缩边界定位正确。
    const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || null, tool_calls: result.toolCalls }
    conversation.append(assistantMsg, assistantPersistId)
    allAssistantMessages.push(assistantMsg)

    const toolPhase = await runToolCallPhase(result.toolCalls, assistantPersistId, {
      ...toolPhaseBase,
      hardStop
    })
    hardStop = toolPhase.hardStop

    // 继续下一轮，让 LLM 看到工具结果后决定下一步
  }

  // 达到轮数上限（无循环硬停）→ 记录原因
  if (!hardStop) {
    hardStop = `Reached max tool rounds (${maxRounds})`
    log('warn', `Agent reached max rounds (${maxRounds})`)
  }

  // 优雅收尾：不带 tools 的最后一次调用，强制模型纯文本总结进度
  await finalizeRun(provider, opts.modelOverride, signal, hardStop, conversation, allAssistantMessages, cb, reasoningEffort, compactor)

  return finishRun(allAssistantMessages, conversation, provider, memoryEnabled, sessionId, cb)
}

/**
 * 正常完成 / 收尾后的公共结束流程：通知完成 + 异步提取长期记忆（不阻塞返回）。
 */
function finishRun(
  allAssistantMessages: ChatMessage[],
  conversation: WorkingConversation,
  provider: ProviderConfig,
  memoryEnabled: boolean | undefined,
  sessionId: string | undefined,
  cb: AgentEventCallbacks
): ChatMessage[] {
  cb.onComplete?.()
  if (memoryEnabled && sessionId) {
    captureMemories(provider, conversation.messages, sessionId).catch(() => {})
  }
  return allAssistantMessages
}

/**
 * 构建工作上下文：清洗历史非法序列 → 应用已有压缩 → system 置首。
 * sanitizeHistoryWithIds 后的消息与 id 平行对齐（清洗删除中间消息时不错位）。
 */
function buildWorkingConversation(opts: AgentRunOptions): WorkingConversation {
  const { messages, messageIds, compaction } = opts
  const skillsPrompt = opts.skillsPrompt || ''
  const memoryPrompt = opts.memoryEnabled ? buildMemoryPrompt(extractTextContent(getLastUserMessage(messages))) : ''
  const toolsForPrompt = opts.promptRuntime?.tools || []
  const promptRuntime: PromptRuntimeSnapshot = opts.promptRuntime || {
    tools: toolsForPrompt, builtinTools: [], mcpTools: [], mcpServers: []
  }
  // 会话仍是默认标题 → 注入命名提醒（否则 LLM 不主动调 set_title 时标题永远不更新）。
  // 放提示词顶部（topExtra）而不是末尾：末尾的指令在长上下文里最容易模型"看不见"。
  const extraParts = [opts.systemPromptExtra]
  const topParts: string[] = opts.systemPromptRole ? [opts.systemPromptRole] : []
  if (opts.sessionNeedsTitle) topParts.push(SESSION_TITLE_REMINDER)
  const systemPrompt = buildSystemPrompt(
    opts.workspacePath, skillsPrompt, memoryPrompt, promptRuntime,
    extraParts.filter(Boolean).join('\n\n'),
    topParts.filter(Boolean).join('\n\n'), opts.memoryEnabled !== false
  )

  const { messages: sanitized, ids: sanitizedIds } = sanitizeHistoryWithIds(messages, messageIds)
  if (sanitized.length !== messages.length) {
    log('info', `Sanitized history: excluded ${messages.length - sanitized.length} dangling or malformed message(s) from the LLM context`)
  }
  const built = buildEffectiveConversation(sanitized, sanitizedIds, compaction)
  const conversationIds: Array<string | null> = built.hasSummary
    ? [null, ...sanitizedIds.slice(built.keptFromIndex)]
    : [...sanitizedIds]

  const conversation = new WorkingConversation(systemPrompt)
  built.effective.forEach((message, i) => conversation.append(message, conversationIds[i] ?? null))
  return conversation
}

/** 发起一轮 LLM 流式调用，聚合 token 回调与本轮思考内容 */
async function streamRound(
  conversation: WorkingConversation,
  provider: ProviderConfig,
  modelOverride: string | undefined,
  reasoningEffort: ReasoningEffortParam | undefined,
  tools: ReturnType<ToolRegistry['definitions']>,
  signal: AbortSignal | undefined,
  cb: AgentEventCallbacks
): Promise<RoundResult> {
  let roundReasoning = ''
  const model = modelOverride || provider.defaultModel
  const { content, toolCalls, usage, finishReason, streamInterrupted } = await streamChat(provider, {
    messages: conversation.messages,
    tools: tools.length > 0 ? tools : undefined,
    toolChoice: 'auto',
    model,
    temperature: provider.temperature,
    reasoningEffort,
    signal
  }, {
    onToken: cb.onToken,
    onReasoningToken: (t) => {
      roundReasoning += t
      cb.onReasoningToken?.(t)
    },
    onError: cb.onError,
    onRetry: cb.onRetry
  })
  return { content, toolCalls, usage, finishReason, reasoning: roundReasoning, streamInterrupted }
}

/** 从消息列表中获取最后一条 user 消息的 content（可能是字符串或多模态 ContentPart[]） */
function getLastUserMessage(messages: ChatMessage[]): ChatMessage['content'] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && msg.content) return msg.content
  }
  return null
}
