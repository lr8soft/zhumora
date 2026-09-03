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
import type { ChatMessage, ProviderConfig, ToolCall, ReasoningEffort } from '../../shared/types'
import { streamChat, type TokenUsage, type ToolChoice } from '../llm/provider'
import { log } from '../llm/logger'
import { toolRegistry, type ToolRegistry } from '../tools/registry'
import { buildMemoryPrompt, captureMemories } from '../memory/manager'
import { needsCompact, fetchContextWindow } from '../agent/context'
import { buildSystemPrompt, type PromptRuntimeSnapshot } from '../agent/promptBuilder'
import { buildEffectiveConversation, sanitizeHistoryWithIds, type CompactionState } from './history'
import { extractTextContent } from '../../shared/multimodal'
import { LoopDetector, DEFAULT_LOOP_CONFIG, type LoopDetectionConfig } from './loopDetector'
import { AgentAbortedError } from '../../shared/types'
import { detectOfficeRoute, selectToolsForOfficeRoute } from './officeRouting'
import { executeToolCall } from './toolExecutor'
import {
  EMPTY_CONTINUE_PROMPT,
  MAX_EMPTY_CONTINUATIONS,
  MAX_TRUNCATION_CONTINUATIONS,
  RecoveryBudget,
  TRUNCATION_CONTINUE_PROMPT,
  TRUNCATION_TOOL_ERROR
} from './recoveryPolicy'
import { WorkingConversation } from './workingConversation'
import { AutoCompactor } from './autoCompact'
import { decideTurnOutcome } from './turnDecision'

export { MAX_EMPTY_CONTINUATIONS, MAX_TRUNCATION_CONTINUATIONS } from './recoveryPolicy'

export const DEFAULT_MAX_TOOL_ROUNDS = 20

export interface AgentEventCallbacks {
  /** LLM 流式 token */
  onToken?: (token: string) => void
  /** LLM 流式思考内容（reasoning_content；仅供 UI 展示，不回传模型） */
  onReasoningToken?: (token: string) => void
  /** LLM 请求了工具调用 */
  onToolCall?: (toolCall: ToolCall, assistantMessageId: string | null) => void
  /** 工具执行完成。返回该 tool 消息落库后的 id（供压缩边界定位），未落库返回 null */
  onToolResult?: (toolCallId: string, toolName: string, result: string, isError: boolean, durationMs: number) => string | null
  /** 一轮 LLM 调用完成（可能继续循环或结束）。返回该 assistant 消息落库后的 id，未落库返回 null */
  onAssistantMessage?: (content: string, toolCalls: ToolCall[], reasoning?: string) => string | null
  /** Token 用量回调 */
  onTokenUsage?: (usage: TokenUsage, model: string) => void
  /** 整个对话完成 */
  onComplete?: () => void
  /** 出错 */
  onError?: (error: Error) => void
  /** LLM 网络失败，正在自动重试 */
  onRetry?: (failedAttempt: number, maxRetries: number, error: Error) => void
  /** 上下文压缩完成（通知前端展示提示 + 更新压缩标记位置） */
  onCompact?: (info: { beforeTokens: number; afterTokens: number; compressedCount: number; keptCount: number; boundaryMessageId?: string }) => void
  /**
   * 单轮输出达到 max_tokens 上限被截断（finish_reason = length）。
   * 通知前端展示"输出被截断"提示条 —— 这是"工作没做完却无报错停止"
   * 的根因场景，必须让用户可见（对齐 opencode / Cline 的 finish_reason 处理）。
   * 截断的文本/工具调用已按原样保留，runner 会自动引导模型续写或重试工具调用。
   */
  onTruncated?: (kind: 'tool' | 'text') => void
}

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

/** streamChat 一次调用的结果 + 本轮思考内容（思考内容不进入模型上下文） */
interface RoundResult {
  content: string
  toolCalls: ToolCall[]
  usage: TokenUsage | null | undefined
  finishReason: string | undefined
  reasoning: string
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

  /**
   * 发送前检查并折叠上下文（工具结果可能很大，导致逐轮膨胀）。
   */
  async function compactIfNeeded(trigger: string): Promise<void> {
    if (!needsCompact(conversation.messages, contextWindow)) return
    log('info', `Auto compact triggered ${trigger}`)
    await compactor.apply(conversation)
  }

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

  let round = 0
  while (maxRounds <= 0 || round < maxRounds) {
    round++
    log('info', `Agent round ${round} — sending ${conversation.messages.length} messages to LLM`)

    // 轮间中止检查优先于压缩：用户已中止时不再发起摘要 LLM 调用
    if (signal?.aborted) throw new AgentAbortedError()
    await compactIfNeeded(`at round ${round}`)

    const tools = selectToolsForOfficeRoute(toolsRegistry.definitions(), officeRoute)
    const routedOfficeAvailable = !!officeRoute && tools.some(tool => tool.function.name === officeRoute.toolName)
    const toolChoice: ToolChoice = routedOfficeAvailable && !officeToolAttempted ? 'required' : 'auto'

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
      continue
    }

    if (decision.kind === 'recover_truncated_text') {
      // content 为空时不推空 assistant 消息（部分严格后端会拒绝），直接续写
      if (result.content) {
        conversation.append({ role: 'assistant', content: result.content }, cb.onAssistantMessage?.(result.content, [], result.reasoning || undefined) ?? null)
        allAssistantMessages.push({ role: 'assistant', content: result.content })
      } else {
        cb.onAssistantMessage?.(result.content, [], result.reasoning || undefined)
      }
      cb.onTruncated?.('text')
      const continuation = recovery.recordTruncation()
      log('warn', `Round ${round}: text output truncated at token limit (finish_reason=length) — continuing (continuation ${continuation}/${MAX_TRUNCATION_CONTINUATIONS})`)
      conversation.appendSyntheticUser(TRUNCATION_CONTINUE_PROMPT)
      continue
    }

    if (decision.kind === 'recover_empty_response') {
      // 空响应自动继续：无正文、无工具调用、且不是截断（finish_reason=stop）。
      // 推理模型偶发"只思考不输出"或空补全 —— 工作没做完却提前收尾。
      // 空 assistant 消息不落库也不进上下文（部分严格后端拒绝空 content），
      // 只追加 user 继续指令。上限防"空响应→继续→再空响应"死循环烧 token。
      // 仍要调用 onAssistantMessage 收尾本轮（回调内部不落库，但重置轮次 id、
      // 通知前端把本轮流式气泡归位）。
      cb.onAssistantMessage?.(result.content, result.toolCalls, result.reasoning || undefined)
      const continuation = recovery.recordEmptyResponse()
      log('warn', `Round ${round}: empty response (no content, no tool call, finish_reason=${result.finishReason || 'stop'}) — injecting continue prompt (continuation ${continuation}/${MAX_EMPTY_CONTINUATIONS})`)
      conversation.appendSyntheticUser(EMPTY_CONTINUE_PROMPT)
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
      cb.onComplete?.()
      // 异步提取记忆（不阻塞返回）
      if (memoryEnabled && sessionId) {
        captureMemories(provider, conversation.messages, sessionId).catch(() => {})
      }
      return allAssistantMessages
    }

    // decision.kind === 'execute_tools'
    // 新的原始工具轮 → 重置截断恢复计数（上一轮截断已被正常消化）
    recovery.resetAfterToolRound()

    // 记录 assistant 消息（含 tool_calls）到工作上下文。
    // 对应 id = 落库 id（无则 null），保证压缩边界定位正确。
    const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || null, tool_calls: result.toolCalls }
    conversation.append(assistantMsg, assistantPersistId)
    allAssistantMessages.push(assistantMsg)

    // 执行每个工具调用
    for (const tc of result.toolCalls) {
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
        context: { workspacePath, sessionId, signal, onSessionTitleUpdate },
        permissionCheck: opts.permissionCheck,
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

    // 继续下一轮，让 LLM 看到工具结果后决定下一步
  }

  // 达到轮数上限（无循环硬停）→ 记录原因
  if (!hardStop) {
    hardStop = `Reached max tool rounds (${maxRounds})`
    log('warn', `Agent reached max rounds (${maxRounds})`)
  }

  // 优雅收尾：不带 tools 的最后一次调用，强制模型纯文本总结进度
  await finalizeRun(provider, opts.modelOverride, signal, hardStop, conversation, allAssistantMessages, cb, reasoningEffort)

  cb.onComplete?.()
  // 异步提取记忆（不阻塞返回）
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
