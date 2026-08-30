// ============================================================
// Agent 调度器 — ReAct 工具调用循环
// 核心流程: 用户输入 → LLM → (tool_calls? → 执行工具 → 回传结果 → LLM)* → 最终回答
//
// 上下文压缩（对齐 Cline / opencode）：
// 压缩状态持久化在 compactions 表（每会话一行：边界消息 id + 摘要）。
// 每次运行从"完整历史 + 压缩记录"构建发给 LLM 的 effective 上下文；
// 压缩只折叠 effective 的前段，数据库与用户可见历史不受影响。
// 运行中触发 auto compact 时把新压缩状态回传 onAutoCompact 持久化。
//
// 内部用 effective[] + effectiveIds[] 两个平行数组维护"当前发给 LLM 的
// 对话上下文"（index 0 恒为 system，effectiveIds[0] = null）。运行中新增的
// assistant / tool 消息追加时同时 push 到两个数组，保证 id 对齐；压缩边界
// 总是取"被折叠的最后一条真实历史消息 id"（跳过虚拟摘要位 null）。
// ============================================================
import type { ChatMessage, ContentPart, ProviderConfig, ToolCall } from '../../shared/types'
import { streamChat, type TokenUsage } from '../llm/provider'
import { log } from '../llm/logger'
import { getTool, getAllTools, type ToolContext } from '../tools/registry'
import { buildMemoryPrompt, captureMemories } from '../memory/manager'
import {
  needsCompact, fetchContextWindow, buildEffectiveConversation,
  planAutoCompact, makeSummaryMessage, type CompactionState
} from '../agent/context'
import { buildSystemPrompt } from '../agent/promptBuilder'
import { sanitizeHistoryWithIds } from './history'
import { extractTextContent } from '../../shared/multimodal'
import { LoopDetector, DEFAULT_LOOP_CONFIG, type LoopDetectionConfig } from './loopDetector'
import { getSettings } from '../store/db'
import { AgentAbortedError } from '../../shared/types'

export const DEFAULT_MAX_TOOL_ROUNDS = 20

/** 同一轮次内"输出被截断"的自动续写次数上限（防止截断 → 续写 → 再截断的死循环） */
export const MAX_TRUNCATION_CONTINUATIONS = 2

/** 单轮输出达到 max_tokens 上限被截断时回传给模型的提示（喂 LLM，固定英文） */
const TRUNCATION_TOOL_ERROR =
  '[Output truncated] Your previous response hit the per-response token limit and was cut off: the tool call arguments are incomplete. Re-issue the call with smaller output — e.g. split file writes into multiple smaller chunks — or take the next smaller step.'

/** 单轮输出达到 max_tokens 上限被截断（纯文本轮）时追加的续写指令（喂 LLM，固定英文） */
const TRUNCATION_CONTINUE_PROMPT =
  '[System notice] Your previous response was truncated by the per-response token limit (max_tokens) and is incomplete. Continue exactly from where you stopped. Do not repeat what you already wrote. If you were about to call a tool, call it now with a smaller output (split large file writes into chunks).'

/** 单次对话最大工具轮数（0 = 不限制）。设置 maxRounds 可配，默认 20 */
export function getMaxToolRounds(): number {
  try {
    const v = getSettings().maxRounds
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v)
  } catch { /* DB 未初始化等场景 → 默认值 */ }
  return DEFAULT_MAX_TOOL_ROUNDS
}

// Skill 提示词通过函数延迟获取，避免初始化顺序问题
let skillsPromptGetter: (() => string) | null = null
export function setSkillsPromptGetter(fn: () => string) {
  skillsPromptGetter = fn
}

export interface AgentEventCallbacks {
  /** LLM 流式 token */
  onToken?: (token: string) => void
  /** LLM 流式思考内容（reasoning_content；仅供 UI 展示，不回传模型） */
  onReasoningToken?: (token: string) => void
  /** LLM 请求了工具调用 */
  onToolCall?: (toolCall: ToolCall) => void
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
  /** 覆盖模型名（如果用户在聊天页选了别的模型） */
  modelOverride?: string
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
  const { provider, workspacePath, messages, messageIds, compaction, signal, permissionCheck, modelOverride, sessionId, memoryEnabled, onSessionTitleUpdate, onAutoCompact } = opts

  // 构建系统提示词（含记忆注入 + MCP 工具动态列表）
  const skillsPrompt = skillsPromptGetter ? skillsPromptGetter() : ''
  const memoryPrompt = memoryEnabled ? buildMemoryPrompt(extractTextContent(getLastUserMessage(messages))) : ''
  const systemPrompt = buildSystemPrompt(workspacePath, skillsPrompt, memoryPrompt, opts.systemPromptExtra)

  // 清洗 abort/崩溃遗留的非法序列（孤儿 tool 结果、不完整的 tool_call 组），
  // 否则第一轮请求就会 400。ids 与消息平行对齐（清洗删除中间消息时不错位）。
  const { messages: sanitized, ids: sanitizedIds } = sanitizeHistoryWithIds(messages, messageIds)
  if (sanitized.length !== messages.length) {
    log('info', `Sanitized history: removed ${messages.length - sanitized.length} dangling message(s)`)
  }

  // 从"完整历史 + 压缩记录"构建当前发给 LLM 的对话上下文（不含 system）。
  // compaction 用 let：运行中 auto compact 成功后更新，供后续边界回退使用。
  let compactionState: CompactionState | null = compaction
  // effectiveIds 与 effective 平行对齐：虚拟摘要位 = null，其余 = 真实消息 id。
  const built = buildEffectiveConversation(sanitized, sanitizedIds, compactionState)
  const conversation: ChatMessage[] = built.effective
  const conversationIds: Array<string | null> = built.hasSummary
    ? [null, ...sanitizedIds.slice(built.keptFromIndex)]
    : [...sanitizedIds]

  // 运行时获取上下文窗口大小（手动配置 → API 探测 → 启发式 → 默认值）
  const contextWindow = await fetchContextWindow(provider, modelOverride)
  log('info', `Context window: ${contextWindow} tokens`)

  // 当前发给 LLM 的完整上下文（index 0 = system）。这是唯一的工作数组：
  // 发送、追加消息、压缩都直接操作它。
  const workingMessages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...conversation]
  // 与 workingMessages 平行对齐的 id（[0] = null）
  const workingIds: Array<string | null> = [null, ...conversationIds]

  /**
   * 执行一次 auto compact（折叠 workingMessages 中 system 之后的前段）。
   * 成功后通过 onAutoCompact 持久化新压缩状态；
   * LLM 摘要失败时退化为截断（本次运行生效，不持久化新状态）。
   */
  async function applyAutoCompact() {
    const effective = workingMessages.slice(1)
    const effectiveIds = workingIds.slice(1)
    const plan = await planAutoCompact(effective, provider, modelOverride, contextWindow)
    if (plan.compressedCount <= 0) {
      log('info', 'Auto compact: no safe boundary to split, skipping')
      return
    }
    // 新边界 = 被折叠的最后一条真实历史消息 id（跳过虚拟摘要位 null）
    const boundaryId = effectiveIds[plan.keptOffset - 1] || compactionState?.upToMessageId || null
    if (plan.summary && boundaryId) {
      onAutoCompact?.({ upToMessageId: boundaryId, summary: plan.summary })
      compactionState = { upToMessageId: boundaryId, summary: plan.summary }
    }
    // 重建工作上下文：保留 system + (新摘要 + toKeep) 或 (仅 toKeep)
    const tail: ChatMessage[] = plan.summary
      ? [makeSummaryMessage(plan.summary), ...plan.toKeep]
      : plan.toKeep
    const tailIds: Array<string | null> = plan.summary
      ? [null, ...effectiveIds.slice(plan.keptOffset)]
      : effectiveIds.slice(plan.keptOffset)
    workingMessages.length = 0
    workingMessages.push({ role: 'system', content: systemPrompt }, ...tail)
    workingIds.length = 0
    workingIds.push(null, ...tailIds)
    log('warn', plan.summary
      ? `Auto compact: boundary persisted at "${boundaryId}"`
      : 'Auto compact: summary failed, truncated for this run only (state not persisted)')
    cb.onCompact?.({
      beforeTokens: plan.beforeTokens,
      afterTokens: plan.afterTokens,
      compressedCount: plan.compressedCount,
      keptCount: plan.keptCount,
      boundaryMessageId: boundaryId || undefined
    })
  }

  // Auto Compact: 发送前检查上下文是否超阈值
  if (needsCompact(workingMessages, contextWindow)) {
    log('info', 'Auto compact triggered before sending')
    await applyAutoCompact()
  }

  const maxRounds = opts.maxRounds ?? getMaxToolRounds()
  const loopConfig = opts.loopConfig || DEFAULT_LOOP_CONFIG
  const loopDetector = new LoopDetector()
  /** 硬停原因（循环检测 / 达到轮数上限）；非 null 时本轮剩余工具跳过，循环结束后触发优雅收尾 */
  let hardStop: string | null = null

  let round = 0
  const allAssistantMessages: ChatMessage[] = []
  /**
   * 同一轮次内"输出被截断（finish_reason=length）"的自动恢复计数。
   * 0 = 当前轮次是原始轮次；>0 = 第 N 次续写/重发。超过
   * MAX_TRUNCATION_CONTINUATIONS 后不再自动恢复，走正常收尾 ——
   * 防止"截断 → 续写 → 再截断"死循环烧 token。
   * 每个新的原始轮次（用户输入 / 工具结果驱动）重置为 0。
   */
  let truncationContinuations = 0

  while (maxRounds <= 0 || round < maxRounds) {
    round++
    log('info', `Agent round ${round} — sending ${workingMessages.length} messages to LLM`)

    // 每轮发送前也检查（工具结果可能很大，导致上下文膨胀）
    if (round > 1 && needsCompact(workingMessages, contextWindow)) {
      log('info', `Auto compact triggered at round ${round}`)
      await applyAutoCompact()
    }

    // 轮间中止检查：provider 层对用户中止按"部分内容正常完成"处理，
    // 若不显式抛出，agent 会带着部分回复继续下一轮 / 执行工具
    if (signal?.aborted) throw new AgentAbortedError()

    const tools = getAllTools()
    const model = modelOverride || provider.defaultModel
    // 当前轮思考内容（每轮独立；落库 + UI 展示，不进入模型上下文）
    let roundReasoning = ''
    const { content, toolCalls, usage, finishReason } = await streamChat(provider, {
      messages: workingMessages,
      tools: tools.length > 0 ? tools : undefined,
      model,
      temperature: provider.temperature,
      reasoningEffort: provider.reasoningEnabled ? provider.reasoningEffort : undefined,
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

    // 回传 token 用量
    if (usage) {
      cb.onTokenUsage?.(usage, model)
    }

    // 中止检查：provider 层对"用户中止"按部分内容正常返回（不抛错）。
    // 若不在此拦截，agent 会把部分回复当完整结果、继续执行工具调用。
    // 先落盘已生成的部分文本，再抛中止错误（IPC 层据此通知前端该会话已停止）。
    if (signal?.aborted) {
      if (content) cb.onAssistantMessage?.(content, [], roundReasoning || undefined)
      throw new AgentAbortedError()
    }

    // finish_reason = length：单轮输出达到 provider 侧 max_tokens 上限被截断。
    // 不处理的话截断轮会"看起来像正常完成"—— 工作没做完、无报错，
    // 这是本修复要解决的根因（对齐 opencode / Cline：finish_reason 是一等信号）。
    const wasTruncated = finishReason === 'length'
    const canRecover = truncationContinuations < MAX_TRUNCATION_CONTINUATIONS

    if (wasTruncated && canRecover && toolCalls.length > 0) {
      // 截断发生在工具轮：tool_calls 参数 JSON 多半不完整，不能执行。
      // 把截断的 assistant 消息作为真实上下文保留（模型能看到自己写到哪里），
      // 给每个调用补一条解释性 tool 结果 → 下一轮引导模型拆小步重发。
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls
      }
      workingMessages.push(assistantMsg)
      workingIds.push(cb.onAssistantMessage?.(content, toolCalls, roundReasoning || undefined) ?? null)
      allAssistantMessages.push(assistantMsg)

      cb.onTruncated?.('tool')
      truncationContinuations++
      log('warn', `Round ${round}: output truncated at token limit (finish_reason=length) — tool call(s) incomplete, asking model to retry with smaller output (continuation ${truncationContinuations}/${MAX_TRUNCATION_CONTINUATIONS})`)
      for (const tc of toolCalls) {
        cb.onToolCall?.(tc)
        const persistId = cb.onToolResult?.(tc.id, tc.function.name, TRUNCATION_TOOL_ERROR, true, 0) ?? null
        workingMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: TRUNCATION_TOOL_ERROR
        })
        workingIds.push(persistId)
      }
      continue
    }

    // 落库并拿到持久化 id（IPC 回调内部写 DB；未落库返回 null）
    const assistantPersistId = cb.onAssistantMessage?.(content, toolCalls, roundReasoning || undefined) ?? null

    // 如果没有工具调用：
    // - 正常结束 → 对话完成
    // - finish_reason=length（纯文本轮被截断）且还有恢复额度 →
    //   追加续写指令继续，而不是把半截回答当最终答复
    if (!toolCalls || toolCalls.length === 0) {
      if (wasTruncated && canRecover) {
        // content 为空时不推空 assistant 消息（部分严格后端会拒绝），直接续写
        if (content) {
          workingMessages.push({ role: 'assistant', content })
          workingIds.push(assistantPersistId)
          allAssistantMessages.push({ role: 'assistant', content })
        }

        cb.onTruncated?.('text')
        truncationContinuations++
        log('warn', `Round ${round}: text output truncated at token limit (finish_reason=length) — continuing (continuation ${truncationContinuations}/${MAX_TRUNCATION_CONTINUATIONS})`)
        workingMessages.push({ role: 'user', content: TRUNCATION_CONTINUE_PROMPT })
        workingIds.push(null)
        continue
      }
      if (wasTruncated) {
        log('warn', `Round ${round}: output truncated and ${MAX_TRUNCATION_CONTINUATIONS} continuations already used — finalizing`)
        cb.onTruncated?.('text')
      }
      log('info', `Agent completed after ${round} round(s)`)
      cb.onComplete?.()
      // 异步提取记忆（不阻塞返回）
      if (memoryEnabled && sessionId) {
        captureMemories(provider, workingMessages, sessionId).catch(() => {})
      }
      return allAssistantMessages
    }

    // 新的原始工具轮 → 重置截断恢复计数（上一轮截断已被正常消化）
    truncationContinuations = 0

    // 记录 assistant 消息（含 tool_calls）到工作上下文。
    // workingIds 对应位置 = 落库 id（无则 null），保证压缩边界定位正确。
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls
    }
    workingMessages.push(assistantMsg)
    workingIds.push(assistantPersistId)
    allAssistantMessages.push(assistantMsg)

    // 执行每个工具调用
    for (const tc of toolCalls) {
      cb.onToolCall?.(tc)

      // 循环检测：工具名 + 参数完全相同地连续调用
      const verdict = loopDetector.inspect(tc.function.name, tc.function.arguments || '')
      if (verdict.kind === 'hard' && !hardStop) {
        hardStop = `Detected ${verdict.count} consecutive identical calls to "${tc.function.name}"`
        log('warn', `Loop detected (hard): ${hardStop} — stopping to avoid a loop`)
      }

      const toolEntry = getTool(tc.function.name)
      let resultText = ''
      let isError = false
      let durationMs = 0
      let imageContent: ContentPart[] | undefined = undefined

      // 把 tool 结果追加进工作上下文（id = 落库 id，无则 null）
      const pushToolResult = (persistId: string | null) => {
        workingMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: imageContent ?? resultText
        })
        workingIds.push(persistId)
      }

      // 中止短路：用户按 Stop 后本轮剩余工具不再执行（占位结果保证消息序列合法）。
      // 下一轮 while 顶部的 signal 检查会抛出 AgentAbortedError 结束本次运行。
      if (signal?.aborted) {
        resultText = 'Execution skipped: aborted by user'
        isError = true
        const id = cb.onToolResult?.(tc.id, tc.function.name, resultText, true, 0) ?? null
        pushToolResult(id)
        continue
      }

      if (!toolEntry) {
        resultText = `Error: Tool "${tc.function.name}" not found`
        isError = true
        log('error', `Tool not found: ${tc.function.name}`)
      } else {
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}')
        } catch {
          resultText = `Error: Invalid JSON arguments: ${tc.function.arguments}`
          isError = true
        }

        if (!isError && hardStop) {
          // 硬停已触发：本条及剩余工具调用不再执行（占位结果保证消息序列合法）
          resultText = `Execution skipped: agent hard-stopped (${hardStop})`
          isError = true
          const id = cb.onToolResult?.(tc.id, tc.function.name, resultText, true, 0) ?? null
          pushToolResult(id)
          continue
        }

        if (!isError) {
          // 权限检查 — 统一由 permissionCheck 决策
          // permissionCheck 内部根据三档批准模式 + 工具权限等级判断是否需要弹窗
          if (permissionCheck) {
            const allowed = await permissionCheck(tc.function.name, parsedArgs)
            if (!allowed) {
              resultText = 'Permission denied by user'
              isError = true
              const id = cb.onToolResult?.(tc.id, tc.function.name, resultText, true, 0) ?? null
              pushToolResult(id)
              continue
            }
          }

          // 执行工具
          const ctx: ToolContext = { workspacePath, sessionId, onSessionTitleUpdate }
          const start = Date.now()
          try {
            log('info', `Executing tool: ${tc.function.name}(${JSON.stringify(parsedArgs).slice(0, 200)})`)
            resultText = await toolEntry.handler.execute(parsedArgs, ctx)
            durationMs = Date.now() - start
            log('info', `Tool ${tc.function.name} completed in ${durationMs}ms`)
            // 循环检测软警告：追加提示引导模型换方法
            if (verdict.kind === 'soft') {
              log('warn', `Loop detected (soft): ${verdict.count} consecutive identical calls to ${tc.function.name}`)
              resultText += `\n\n[Loop warning] This exact call to ${tc.function.name} has now been made ${verdict.count} times in a row. Stop repeating it — try a different approach or proceed to the next step.`
            }
          } catch (err) {
            durationMs = Date.now() - start
            resultText = `Error: ${(err as Error).message}`
            isError = true
            log('error', `Tool ${tc.function.name} failed: ${(err as Error).message}`)
          }
        }
      }

      // 截图结果可能混在文本中（desktop 工具 after=true 时：动作文本 + 截图 marker），
      // 用正则提取 base64 段；传给前端/DB 的只剩文本，避免 base64 爆炸
      const imgMatch = !isError ? resultText.match(/__IMAGE_BASE64__:\s*([A-Za-z0-9+/=]+)/) : null
      const isImageResult = !!imgMatch
      const imageBase64 = imgMatch ? imgMatch[1] : ''
      const imageTextPart = imgMatch ? resultText.replace(/\n?__IMAGE_BASE64__:[A-Za-z0-9+/=]+/, '').trim() : ''
      const displayResult = isImageResult
        ? imageTextPart
          ? `${imageTextPart}\n[screenshot attached, sent to LLM for visual analysis]`
          : 'Screenshot captured (image sent to LLM for visual analysis)'
        : resultText

      // 追加 tool 消息 — 如果结果是 base64 图片，组装为 OpenAI 多模态格式
      if (isImageResult) {
        imageContent = []
        if (imageTextPart) imageContent.push({ type: 'text', text: imageTextPart })
        imageContent.push({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${imageBase64}`, detail: 'auto' }
        })
      }
      const persistId = cb.onToolResult?.(tc.id, tc.function.name, displayResult, isError, durationMs) ?? null
      pushToolResult(persistId)
    }

    // 继续下一轮，让 LLM 看到工具结果后决定下一步
  }

  // 达到轮数上限（无循环硬停）→ 记录原因
  if (!hardStop) {
    hardStop = `Reached max tool rounds (${maxRounds})`
    log('warn', `Agent reached max rounds (${maxRounds})`)
  }

  // 优雅收尾：不带 tools 的最后一次调用，强制模型纯文本总结进度
  await finalizeRun(provider, modelOverride, signal, hardStop, workingMessages, allAssistantMessages, cb)

  cb.onComplete?.()
  // 异步提取记忆（不阻塞返回）
  if (memoryEnabled && sessionId) {
    captureMemories(provider, workingMessages, sessionId).catch(() => {})
  }
  return allAssistantMessages
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
  workingMessages: ChatMessage[],
  allAssistantMessages: ChatMessage[],
  cb: AgentEventCallbacks
): Promise<void> {
  const finalizeMessages: ChatMessage[] = [
    ...workingMessages,
    {
      role: 'user',
      content: `[System notice] The agent run has been stopped: ${reason}. You must now respond with text only — do NOT call any tools. In 1-3 short paragraphs, summarize: (1) what has been accomplished so far, (2) what remains to be done, (3) any important file paths or decisions. Be concrete and actionable so the user can continue in the next message.`
    }
  ]
  try {
    const model = modelOverride || provider.defaultModel
    let roundReasoning = ''
    const { content, toolCalls, usage } = await streamChat(provider, {
      messages: finalizeMessages,
      tools: undefined,   // 无 tools → 强制纯文本
      model,
      temperature: provider.temperature,
      reasoningEffort: provider.reasoningEnabled ? provider.reasoningEffort : undefined,
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
    workingMessages.push(msg)
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
