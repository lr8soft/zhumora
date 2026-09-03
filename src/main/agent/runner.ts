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
import { streamChat, type ToolChoice } from '../llm/provider'
import { log } from '../llm/logger'
import { toolRegistry, type ToolRegistry } from '../tools/registry'
import { buildMemoryPrompt, captureMemories } from '../memory/manager'
import { fetchContextWindow } from '../agent/context'
import { buildSystemPrompt, type PromptRuntimeSnapshot } from '../agent/promptBuilder'
import { buildEffectiveConversation, sanitizeHistoryWithIds, type CompactionState } from './history'
import { extractTextContent } from '../../shared/multimodal'
import { LoopDetector, DEFAULT_LOOP_CONFIG, type LoopDetectionConfig } from './loopDetector'
import { AgentAbortedError } from '../../shared/types'
import { detectOfficeRoute, selectToolsForOfficeRoute } from './officeRouting'
import { MAX_EMPTY_CONTINUATIONS, MAX_TRUNCATION_CONTINUATIONS, RecoveryBudget } from './recoveryPolicy'
import { WorkingConversation } from './workingConversation'
import { AutoCompactor } from './autoCompact'
import { decideTurnOutcome } from './turnDecision'
import { applyRecoveryDecision, runToolCallPhase, type ToolPhaseOptions } from './turnEffects'
import type { AgentEventCallbacks, RoundResult } from './eventCallbacks'

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
  /** 由组合根提供的已加载 Skill 提示词，runner 不读取模块级全局状态。 */
  skillsPrompt?: string
  /** 构建系统提示词所需的运行时快照，避免 prompt builder 反向依赖 MCP/registry。 */
  promptRuntime?: PromptRuntimeSnapshot
  /** 应用组合根构造的工具注册表；测试可传隔离实例。 */
  toolRegistry?: ToolRegistry
  /** 覆盖模型名（如果用户在聊天页选了别的模型） */
  modelOverride?: string
  /** 对话级思考强度（聊天输入框选择；'off'/undefined = 不发送 reasoning_effort 参数） */
  reasoningEffort?: ReasoningEffort
  /** 是否启用长期记忆（提取 + 注入） */
  memoryEnabled?: boolean
  /** 最大工具轮数（0 = 不限制）；不传则读设置 maxRounds，默认 20 */
  maxRounds?: number
  /** 循环检测阈值（默认 soft=3 / hard=5） */
  loopConfig?: LoopDetectionConfig
  /** 会话标题更新回调（由 IPC 层注入） */
  onSessionTitleUpdate?: (sessionId: string, title: string) => void
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
  // 对话级思考强度（'off'/undefined = 不发送参数，模型默认行为）。
  // 收窄为 streamChat 接受的 'low'|'medium'|'high'
  const reasoningEffort = opts.reasoningEffort && opts.reasoningEffort !== 'off' ? opts.reasoningEffort : undefined

  const conversation = buildWorkingConversation(opts)
  const contextWindow = await fetchContextWindow(provider, opts.modelOverride)
  log('info', `Context window: ${contextWindow} tokens`)

  const compactor = new AutoCompactor({
    provider,
    modelOverride: opts.modelOverride,
    contextWindow,
    persist: opts.onAutoCompact,
    onCompact: (info) => cb.onCompact?.(info)
  }, compaction)

  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_TOOL_ROUNDS
  const loopConfig = opts.loopConfig || DEFAULT_LOOP_CONFIG
  const loopDetector = new LoopDetector()
  const recovery = new RecoveryBudget()
  /** 硬停原因（循环检测 / 达到轮数上限）；非 null 时本轮剩余工具跳过，循环结束后触发优雅收尾 */
  let hardStop: string | null = null
  const allAssistantMessages: ChatMessage[] = []

  // office 领域路由：决定本轮暴露哪些工具、是否强制首选工具。
  const officeRoute = detectOfficeRoute(
    extractTextContent(getLastUserMessage(messages)),
    buildRecentRouteContext(messages)
  )
  if (officeRoute) log('info', `Office artifact route selected: ${officeRoute.format} -> ${officeRoute.toolName}`)
  let officeToolAttempted = false

  // 工具阶段的静态依赖只构造一次；hardStop / officeToolAttempted 每轮从
  // 局部变量同步进 base（phase 内部推进后由返回值带回）
  const toolPhaseBase: Omit<ToolPhaseOptions, 'hardStop' | 'officeToolAttempted'> = {
    conversation,
    toolsRegistry,
    workspacePath,
    sessionId,
    signal,
    permissionCheck: opts.permissionCheck,
    onSessionTitleUpdate,
    loopDetector,
    loopConfig,
    officeRoute,
    cb
  }

  let round = 0
  while (maxRounds <= 0 || round < maxRounds) {
    round++
    log('info', `Agent round ${round} — sending ${conversation.messages.length} messages to LLM`)

    // 轮间中止检查优先于压缩：用户已中止时不再发起摘要 LLM 调用
    if (signal?.aborted) throw new AgentAbortedError()
    // round=1 的检查即"发送前检查"，后续轮检查工具结果带来的膨胀
    await compactor.applyIfOverThreshold(conversation, `at round ${round}`)

    const tools = selectToolsForOfficeRoute(toolsRegistry.definitions(), officeRoute)
    // office 路由：首选工具可用且尚未尝试 → 强制 tool_choice=required
    const routedOfficeAvailable = !!officeRoute && !officeToolAttempted
      && tools.some(tool => tool.function.name === officeRoute.toolName)
    const toolChoice: ToolChoice = routedOfficeAvailable ? 'required' : 'auto'

    const result = await streamRound(conversation, provider, opts.modelOverride, reasoningEffort, tools, toolChoice, signal, cb)
    if (result.usage) cb.onTokenUsage?.(result.usage, opts.modelOverride || provider.defaultModel)

    // 中止检查：provider 层对"用户中止"按部分内容正常返回（不抛错）。
    // 若不在此拦截，agent 会把部分回复当完整结果、继续执行工具调用。
    // 先落盘已生成的部分文本，再抛中止错误（IPC 层据此通知前端该会话已停止）。
    if (signal?.aborted) {
      if (result.content) cb.onAssistantMessage?.(result.content, [], result.reasoning || undefined)
      throw new AgentAbortedError()
    }

    // finish_reason=length / 空响应 / 工具轮 / 正常完成的分支决策是纯状态机
    // （turnDecision），这里只执行决策的副作用。
    const decision = decideTurnOutcome({
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls.length,
      contentEmpty: !result.content.trim(),
      canRecoverTruncation: recovery.canRecoverTruncation(),
      canRecoverEmptyResponse: recovery.canRecoverEmptyResponse()
    })

    // 恢复类决策（截断工具轮 / 截断文本轮 / 空响应轮）执行完即进入下一轮
    if (decision.kind !== 'complete' && decision.kind !== 'execute_tools') {
      applyRecoveryDecision(decision, result, round, conversation, allAssistantMessages, recovery, cb)
      continue
    }

    // 落库并拿到持久化 id（IPC 回调内部写 DB；未落库返回 null）
    const assistantPersistId = cb.onAssistantMessage?.(result.content, result.toolCalls, result.reasoning || undefined) ?? null

    if (decision.kind === 'complete') {
      if (decision.truncatedNotice) {
        log('warn', `Round ${round}: output truncated and ${MAX_TRUNCATION_CONTINUATIONS} continuations already used — finalizing`)
        cb.onTruncated?.('text')
      }
      log('info', `Agent completed after ${round} round(s)`)
      return finishRun(allAssistantMessages, conversation, provider, memoryEnabled, sessionId, cb)
    }

    // decision.kind === 'execute_tools'
    // 新的原始工具轮 → 重置截断恢复计数（上一轮截断已被正常消化）
    recovery.resetAfterToolRound()

    // 记录 assistant 消息（含 tool_calls）到工作上下文。
    // 对应 id = 落库 id（无则 null），保证压缩边界定位正确。
    const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || null, tool_calls: result.toolCalls }
    conversation.append(assistantMsg, assistantPersistId)
    allAssistantMessages.push(assistantMsg)

    const toolPhase = await runToolCallPhase(result.toolCalls, assistantPersistId, {
      ...toolPhaseBase,
      hardStop,
      officeToolAttempted
    })
    hardStop = toolPhase.hardStop
    officeToolAttempted = toolPhase.officeToolAttempted

    // 继续下一轮，让 LLM 看到工具结果后决定下一步
  }

  // 达到轮数上限（无循环硬停）→ 记录原因
  if (!hardStop) {
    hardStop = `Reached max tool rounds (${maxRounds})`
    log('warn', `Agent reached max rounds (${maxRounds})`)
  }

  // 优雅收尾：不带 tools 的最后一次调用，强制模型纯文本总结进度
  await finalizeRun(provider, opts.modelOverride, signal, hardStop, conversation, allAssistantMessages, cb, reasoningEffort)

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
  const systemPrompt = buildSystemPrompt(opts.workspacePath, skillsPrompt, memoryPrompt, promptRuntime, opts.systemPromptExtra)

  const { messages: sanitized, ids: sanitizedIds } = sanitizeHistoryWithIds(messages, messageIds)
  if (sanitized.length !== messages.length) {
    log('info', `Sanitized history: removed ${messages.length - sanitized.length} dangling message(s)`)
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
  reasoningEffort: 'low' | 'medium' | 'high' | undefined,
  tools: ReturnType<ToolRegistry['definitions']>,
  toolChoice: ToolChoice,
  signal: AbortSignal | undefined,
  cb: AgentEventCallbacks
): Promise<RoundResult> {
  let roundReasoning = ''
  const model = modelOverride || provider.defaultModel
  const { content, toolCalls, usage, finishReason } = await streamChat(provider, {
    messages: conversation.messages,
    tools: tools.length > 0 ? tools : undefined,
    toolChoice,
    // office 路由的降级策略由调用方显式批准：路由工具被端点拒绝时才回落 auto
    toolChoiceFallback: toolChoice === 'required' ? 'auto' : undefined,
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
  return { content, toolCalls, usage, finishReason, reasoning: roundReasoning }
}

/** 最近若干条历史拼成的路由上下文文本（office 路由判断用） */
function buildRecentRouteContext(messages: ChatMessage[]): string {
  return messages.slice(-12, -1).map(message => {
    const calledTools = message.tool_calls?.map(call => call.function.name).join(' ') || ''
    return `${extractTextContent(message.content)} ${message.name || ''} ${calledTools}`
  }).join('\n')
}

/**
 * 停止时的优雅收尾（达到轮数上限 / 循环硬停）
 * 追加一条收尾指令后发起一次不带 tools 的调用，强制模型纯文本输出：
 * 已完成什么、剩下什么、关键文件路径。收尾调用失败不影响主流程。
 */
async function finalizeRun(
  provider: ProviderConfig,
  modelOverride: string | undefined,
  signal: AbortSignal | undefined,
  reason: string,
  conversation: WorkingConversation,
  allAssistantMessages: ChatMessage[],
  cb: AgentEventCallbacks,
  reasoningEffort: 'low' | 'medium' | 'high' | undefined
): Promise<void> {
  const finalizeMessages: ChatMessage[] = [
    ...conversation.messages,
    {
      role: 'user',
      content: `[System notice] The agent run has been stopped: ${reason}. You must now respond with text only — do NOT call any tools. In 1-3 short paragraphs, summarize: (1) what has been accomplished so far, (2) what remains to be done, (3) any important file paths or decisions. Be concrete and actionable so the user can continue in the next message.`
    }
  ]
  try {
    const model = modelOverride || provider.defaultModel
    let roundReasoning = ''
    const { content, usage } = await streamChat(provider, {
      messages: finalizeMessages,
      tools: undefined,   // 无 tools → 强制纯文本
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
      // 收尾失败不覆盖主流程错误状态、不触发重试 UI
      onError: undefined,
      onRetry: undefined
    })
    if (usage) cb.onTokenUsage?.(usage, model)
    // 理论上无 tools 不会产生 tool_calls；若个别模型仍返回，丢弃（不入库，避免悬空）
    const msg: ChatMessage = { role: 'assistant', content: content || null }
    conversation.append(msg, null)
    allAssistantMessages.push(msg)
    cb.onAssistantMessage?.(content, [], roundReasoning || undefined)
    log('info', 'Finalize summary completed')
  } catch (err) {
    log('error', `Finalize summary failed: ${(err as Error).message}`)
  }
}

/** 从消息列表中获取最后一条 user 消息的 content（可能是字符串或多模态 ContentPart[]） */
function getLastUserMessage(messages: ChatMessage[]): ChatMessage['content'] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && msg.content) return msg.content
  }
  return null
}
