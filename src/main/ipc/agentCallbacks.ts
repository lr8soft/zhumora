// ============================================================
// Agent 回调构建器 — 从 IPC handler 中提取的回调与权限逻辑
// ============================================================
import type { BrowserWindow } from 'electron'
import type { AgentEventCallbacks } from '../agent/runner'
import type { TokenUsage } from '../llm/provider'
import type { PermissionLevel } from '../tools/registry'
import type { AutoApproveMode } from '../../shared/types'
import { getToolPermission, isAlwaysConfirm } from '../tools/registry'
import * as db from '../store/db'
import { log } from '../llm/logger'

export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * 构建 Agent 事件回调对象
 * 将流式 token、工具调用、工具结果、assistant 消息等事件转发到前端 + 存入 DB
 */
export function buildAgentCallbacks(
  sessionId: string,
  sender: Electron.WebContents
): {
  callbacks: AgentEventCallbacks
} {
  let streamingMsgId: string | null = null
  let streamingContent = ''
  let streamingReasoning = ''
  /** 当前 LLM 轮次的 messageId（每轮独立：onAssistantMessage 在轮结束时调用，
   *  会重置并开启下一轮） */
  let roundMsgId: string | null = null
  /** 当前轮已收到的思考内容（onReasoningToken 累积，onAssistantMessage 落库后清空） */
  let roundReasoning = ''

  /** 确保当前轮已有 messageId：无则生成并广播 assistant 消息事件
   *  （UI 据此把 thinking 占位替换为正式流式消息，后续 token 精确路由到该消息）。
   *  在首个 token（含思考 token）之前就发出，解决旧实现"token 的 messageId 滞后一轮"的串台问题。 */
  const ensureRoundMsgId = (): string => {
    if (!roundMsgId) {
      roundMsgId = genId()
      sender.send('agent:assistant_message', { sessionId, messageId: roundMsgId, content: '', toolCalls: [], phase: 'start' })
    }
    return roundMsgId
  }

  const callbacks: AgentEventCallbacks = {
    onToken: (token) => {
      streamingContent += token
      // token 携带当前轮 messageId → UI 精确路由，多会话并行不串台
      sender.send('agent:token', { sessionId, messageId: ensureRoundMsgId(), token })
    },
    onReasoningToken: (token) => {
      // 思考内容：仅推给 UI 展示（不进正文、不喂回模型）。
      // 首个思考 token 同样触发 ensureRoundMsgId → thinking 占位此时即被替换，
      // 用户能实时看到"思考中 + 最新一行"而非干等转圈。
      roundReasoning += token
      streamingReasoning = roundReasoning
      sender.send('agent:reasoning', { sessionId, messageId: ensureRoundMsgId(), token })
    },
    onToolCall: (toolCall) => {
      sender.send('agent:tool_call', { sessionId, toolCall })
    },
    onToolResult: (toolCallId, toolName, result, isError, durationMs) => {
      const toolMsg = {
        id: genId(),
        sessionId,
        role: 'tool' as const,
        content: result,
        toolCallId,
        toolName,
        timestamp: Date.now(),
        status: isError ? ('error' as const) : ('done' as const)
      }
      db.addMessage(toolMsg)
      sender.send('agent:tool_result', { sessionId, toolCallId, toolName, result, isError, durationMs })
      // 返回落库 id：runner 把它记进 workingIds，供压缩边界定位
      return toolMsg.id
    },
    onAssistantMessage: (content, toolCalls, reasoning) => {
      // 本轮结束：复用流式 token 的 messageId 落库（纯工具轮无文本无思考时不落空消息）
      let persistedId: string | null = null
      if (content || toolCalls.length > 0 || reasoning) {
        const msgId = ensureRoundMsgId()
        db.addMessage({
          id: msgId,
          sessionId,
          role: 'assistant' as const,
          content: content || '',
          // 思考内容单独列存储（业界对齐 Cline / opencode）；
          // 重建 LLM 历史时只读 content 列，reasoning 永不喂回模型
          reasoning: reasoning || roundReasoning || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: Date.now(),
          status: 'done' as const
        })
        persistedId = msgId
      }
      streamingMsgId = roundMsgId
      streamingContent = content || ''
      streamingReasoning = reasoning || roundReasoning || ''
      // 开启下一轮（下一轮 token 会用新的 messageId）
      roundMsgId = null
      roundReasoning = ''
      // 通知前端：本轮 assistant 消息已收尾（UI 据此把流式消息置为 done；
      // reasoning 作为权威值覆盖 UI 侧累积值，防个别 chunk 丢失）
      sender.send('agent:assistant_message', { sessionId, messageId: streamingMsgId || '', content, toolCalls, phase: 'end', reasoning: streamingReasoning || undefined })
      // 返回落库 id（未落库返回 null）：runner 据此对齐 workingIds
      return persistedId
    },
    onTokenUsage: (usage: TokenUsage, model: string) => {
      // 30 分钟桶累加（全局用量统计，不再按 session 存）
      db.addTokenUsage(model, usage.prompt_tokens, usage.completion_tokens, Date.now())
    },
    onComplete: () => {
      // 如果最后一轮没有 toolCalls（纯文本回复），onAssistantMessage 已存
      // 如果 onAssistantMessage 没被调用（空回复），补存一条
      if (!streamingMsgId) {
        const msgId = genId()
        db.addMessage({
          id: msgId,
          sessionId,
          role: 'assistant',
          content: streamingContent || '',
          reasoning: streamingReasoning || undefined,
          timestamp: Date.now(),
          status: 'done'
        })
      }
      sender.send('agent:complete', { sessionId, messageId: streamingMsgId || '', content: streamingContent })
    },
    onError: (error) => {
      const errMsg = `Error: ${error.message}`
      if (roundMsgId) {
        // 本轮已开始流式（尚未落库）→ 以本轮 messageId 存错误消息（保留部分文本 + 部分思考）
        db.addMessage({
          id: roundMsgId,
          sessionId,
          role: 'assistant',
          content: streamingContent ? `${streamingContent}\n\n${errMsg}` : errMsg,
          reasoning: roundReasoning || undefined,
          timestamp: Date.now(),
          status: 'error'
        })
      } else if (!streamingMsgId) {
        // 还没开始任何一轮 → 存一条错误消息
        db.addMessage({
          id: genId(),
          sessionId,
          role: 'assistant',
          content: errMsg,
          timestamp: Date.now(),
          status: 'error'
        })
      }
      sender.send('agent:error', { sessionId, error: error.message })
    },
    onRetry: (failedAttempt, maxRetries) => {
      sender.send('agent:retry', { sessionId, failedAttempt, maxRetries })
    },
    onTruncated: (kind) => {
      // 单轮输出被 max_tokens 截断 → 前端展示提示条（截断内容本身已按原样流式展示）
      sender.send('agent:truncated', { sessionId, kind })
    },
    onCompact: (info) => {
      // source=auto：agent 运行中的自动压缩（只影响 LLM 上下文，消息表不变；
      // 但压缩状态已持久化 → 前端用 boundaryMessageId 更新"历史已折叠"标记）
      sender.send('agent:compact', { sessionId, source: 'auto', ...info })
    }
  }

  return {
    callbacks
  }
}

/**
 * 构建权限检查闭包
 *
 * 三档批准模式：
 * - manual: safe 放行，normal + dangerous 弹窗
 * - auto:   safe + normal 放行，dangerous 弹窗
 * - full:   全部放行，不弹窗
 *
 * 注意：approveModeGetter 是函数而非固定值，
 * 这样渲染进程运行中切换模式时 main 进程能实时感知。
 */
export function buildPermissionCheck(
  sessionId: string,
  approveModeGetter: () => AutoApproveMode,
  sender: Electron.WebContents,
  pendingPermissions: Map<string, { sessionId: string; resolve: (ok: boolean) => void }>
): (toolName: string, args: Record<string, unknown>) => Promise<boolean> {
  return async (toolName: string, args: Record<string, unknown>): Promise<boolean> => {
    const level: PermissionLevel = getToolPermission(toolName, args)
    const mode = approveModeGetter()
    // 强制弹窗工具（配置变更类，如 MCP 服务器增删改）：
    // full 模式的语义是信任 agent 的日常操作，但不包括改变 agent 自身能力边界的操作
    const mustConfirm = isAlwaysConfirm(toolName)

    if (!mustConfirm) {
      // full 模式：全部放行
      if (mode === 'full') return true
      // safe 工具在所有模式下都放行
      if (level === 'safe') return true
      // auto 模式：normal 也放行，仅 dangerous 需要弹窗
      if (mode === 'auto' && level === 'normal') return true
    }

    // 到达这里 = 需要弹窗确认：
    //   manual 模式的 normal + dangerous
    //   auto 模式的 dangerous
    const permId = genId()
    log('info', `Permission dialog needed: tool=${toolName}, level=${level}, mode=${mode}, permId=${permId}`)
    return new Promise<boolean>((resolve) => {
      pendingPermissions.set(permId, { sessionId, resolve })
      sender.send('agent:permission_request', {
        sessionId, permId, toolName, args, level
      })
    })
  }
}
