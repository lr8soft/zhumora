// ============================================================
// 上下文管理 — Token 估算 + Auto Compact
// 当上下文使用超过阈值时自动压缩对话历史
// ============================================================
import { extractTextContent } from '../../shared/multimodal'
import type { ChatMessage, ProviderConfig, UIMessage } from '../../shared/types'
import { COMPACT_SUMMARY_PREFIX } from '../../shared/types'
import { complete } from '../llm/provider'
import { getFetch } from '../net/fetch'
import { log } from '../llm/logger'
import { planCompactByTokens } from './history'

// 默认上下文窗口（API 未返回时的 fallback）
const DEFAULT_CONTEXT_WINDOW = 32768

// ===== Cline 对齐的压缩常量 =====
/** 可用输入占比（当模型只报告 context window 时的保守输入比例） */
const CONTEXT_WINDOW_INPUT_RATIO = 0.9
/** 触发 auto compact 的比例（相对可用输入预算） */
const COMPACTION_TRIGGER_RATIO = 0.9
/** 压缩后保留的最近 token 预算（Cline: 20_000） */
const DEFAULT_PRESERVE_RECENT_TOKENS = 20_000
/** 摘要输入中工具结果的字符截断限制（Cline: 2_000） */
const TOOL_RESULT_CHAR_LIMIT = 2_000
/** 摘要输入中每条文本的最大字符（防止单条超长消息撑爆摘要 prompt） */
const MAX_SINGLE_MSG_CHARS = 4_000

// 计算触发阈值：contextWindow × INPUT_RATIO × TRIGGER_RATIO（= contextWindow × 0.81）
export function getCompactThreshold(contextWindow: number): number {
  const usableInput = contextWindow * CONTEXT_WINDOW_INPUT_RATIO
  return Math.floor(usableInput * COMPACTION_TRIGGER_RATIO)
}

// 计算保留 token 预算：min(20k, contextWindow × 0.3)
// 对大窗口（128k+）保留 20k，对小窗口（32k）按比例缩小避免保留过多
export function getPreserveTokenBudget(contextWindow: number): number {
  return Math.min(DEFAULT_PRESERVE_RECENT_TOKENS, Math.floor(contextWindow * 0.3))
}

// 缓存：provider+model → contextWindow
const contextWindowCache = new Map<string, number>()

/**
 * 从 API 动态获取模型的上下文窗口大小
 *
 * 尝试顺序：
 * 1. 用户在 ProviderConfig.contextWindow 手动配置 → 直接使用
 * 2. GET /v1/models → data[0].meta.n_ctx（llama.cpp 扩展字段）
 * 3. GET /props → default_generation_settings.n_ctx（llama.cpp 专有端点）
 * 4. POST /api/show → model_info.<arch>.context_length（Ollama 专有端点）
 * 5. 以上都失败 → DEFAULT_CONTEXT_WINDOW
 */
export async function fetchContextWindow(provider: ProviderConfig, modelOverride?: string): Promise<number> {
  // 用户手动配置优先
  if (provider.contextWindow && provider.contextWindow > 0) {
    return provider.contextWindow
  }

  const model = modelOverride || provider.defaultModel
  const cacheKey = `${provider.baseUrl}::${model}`
  if (contextWindowCache.has(cacheKey)) {
    return contextWindowCache.get(cacheKey)!
  }

  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`
  }

  let nCtx: number | null = null

  // 尝试 1: GET /v1/models — llama.cpp 返回 data[].meta.n_ctx
  try {
    const resp = await getFetch()(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(5000) })
    if (resp.ok) {
      const json: any = await resp.json()
      const models = json.data || json.models
      if (Array.isArray(models) && models.length > 0) {
        const meta = models[0].meta
        if (meta && typeof meta.n_ctx === 'number' && meta.n_ctx > 0) {
          nCtx = meta.n_ctx
          log('info', `Context window from /v1/models: n_ctx=${nCtx}`)
        }
      }
    }
  } catch {
    // 忽略，继续尝试下一个端点
  }

  // 尝试 2: GET /props — llama.cpp 专有端点
  if (nCtx === null) {
    try {
      // /props 可能在 baseUrl 根目录下，也可能在 /v1 下
      for (const propsUrl of [`${baseUrl.replace(/\/v1$/, '')}/props`, `${baseUrl}/../props`]) {
        try {
          const resp = await getFetch()(propsUrl, { headers, signal: AbortSignal.timeout(5000) })
          if (resp.ok) {
            const json: any = await resp.json()
            const settings = json.default_generation_settings
            if (settings && typeof settings.n_ctx === 'number' && settings.n_ctx > 0) {
              nCtx = settings.n_ctx
              log('info', `Context window from /props: n_ctx=${nCtx}`)
              break
            }
          }
        } catch {
          continue
        }
      }
    } catch {
      // 忽略
    }
  }

  // 尝试 3: POST /api/show — Ollama 专有端点
  if (nCtx === null) {
    try {
      const ollamaUrl = baseUrl.replace(/\/v1$/, '').replace(/\/api$/, '')
      const resp = await getFetch()(`${ollamaUrl}/api/show`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: model }),
        signal: AbortSignal.timeout(5000)
      })
      if (resp.ok) {
        const json: any = await resp.json()
        const modelInfo = json.model_info
        if (modelInfo) {
          // 查找 <arch>.context_length 字段
          for (const [key, value] of Object.entries(modelInfo)) {
            if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
              nCtx = value
              log('info', `Context window from /api/show: ${key}=${nCtx}`)
              break
            }
          }
        }
      }
    } catch {
      // 忽略
    }
  }

  if (nCtx !== null) {
    contextWindowCache.set(cacheKey, nCtx)
    return nCtx
  }

  log('warn', `Could not detect context window for ${model} at ${baseUrl}, using default ${DEFAULT_CONTEXT_WINDOW}`)
  contextWindowCache.set(cacheKey, DEFAULT_CONTEXT_WINDOW)
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * 获取上下文窗口大小（同步版本，使用缓存或手动配置）
 * 首次调用前应先调用 fetchContextWindow
 */
export function getContextWindow(provider: ProviderConfig, modelOverride?: string): number {
  if (provider.contextWindow && provider.contextWindow > 0) {
    return provider.contextWindow
  }

  const model = modelOverride || provider.defaultModel
  const cacheKey = `${provider.baseUrl}::${model}`
  const cached = contextWindowCache.get(cacheKey)
  if (cached) {
    return cached
  }

  return DEFAULT_CONTEXT_WINDOW
}

// CJK（中日韩）字符范围：这些字符约 1 token/字，而拉丁字符约 4 字符/token。
// 用正则计数 CJK 字符，其余按 4 字符/token，避免中文被低估 3-4 倍。
const CJK_REGEX = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f]/g

/** 估算一段纯文本的 token 数（CJK 感知） */
function estimateTextTokens(text: string): number {
  const cjkCount = text.match(CJK_REGEX)?.length ?? 0
  const nonCjkChars = text.length - cjkCount
  return cjkCount + Math.ceil(nonCjkChars / 4)
}

/** 估算单条消息的 token 数（CJK 感知） */
export function estimateMessageTokens(msg: ChatMessage): number {
  let tokens = 4 // 元数据开销（role/name/分隔符等，约 16 字符 ≈ 4 tokens）
  if (msg.content) {
    if (Array.isArray(msg.content)) {
      // 多模态 content parts（如截图）
      for (const part of msg.content) {
        if (part.type === 'text') {
          tokens += estimateTextTokens(part.text)
        } else if (part.type === 'image_url') {
          // base64 图片：粗略估算（沿用原口径 base64 长度 / 24，实际取决于模型视觉编码）
          const url = part.image_url?.url || ''
          const b64Start = url.indexOf('base64,')
          const b64 = b64Start >= 0 ? url.length - b64Start - 7 : url.length
          tokens += Math.ceil(b64 / 24)
        }
      }
    } else {
      tokens += estimateTextTokens(msg.content)
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTextTokens(tc.function.name) + estimateTextTokens(tc.function.arguments) + 5
    }
  }
  if (msg.name) {
    tokens += estimateTextTokens(msg.name)
  }
  return tokens
}

/**
 * 估算消息列表的 token 数（CJK 感知）
 * 对中文/日文等 CJK 文本按 1 token/字估算，避免 chars/4 的严重低估
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateMessageTokens(m)
  return total
}

/**
 * 检查是否需要触发 auto compact
 * 阈值 = contextWindow × INPUT_RATIO(0.9) × TRIGGER_RATIO(0.9) = 81%
 * （Cline 对齐：先按输入占比算可用预算，再在预算上用触发比例）
 */
export function needsCompact(
  messages: ChatMessage[],
  contextWindow: number
): boolean {
  const used = estimateTokens(messages)
  const threshold = getCompactThreshold(contextWindow)
  log('info', `Context check: ${used} / ${threshold} tokens (threshold=${threshold}, window=${contextWindow})`)
  return used >= threshold
}

/** autoCompact 返回值：压缩后的消息 + 压缩详情（用于通知前端） */
export interface CompactResult {
  messages: ChatMessage[]
  info: { beforeTokens: number; afterTokens: number; compressedCount: number; keptCount: number }
  /**
   * 被保留的原始 UI 消息（带 id/timestamp），仅当调用方传入 uiMessages 时提供。
   * 手动压缩写回 DB 时使用：摘要消息 + 这些保留消息 重建会话历史。
   */
  keptUiMessages?: UIMessage[]
}

/** 截断超长文本用于摘要输入（Cline: TOOL_RESULT_CHAR_LIMIT） */
function truncateForSummary(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`
}

/**
 * 执行 auto compact：将早期消息压缩为摘要，保留最近 N 条
 *
 * @param uiMessages 可选。与 messages 同源的原始 UI 消息（DB 行，带 id/timestamp），
 *                   用于在压缩后把保留部分原样写回数据库（手动压缩场景）。
 * @param contextWindow 模型上下文窗口大小，用于计算保留 token 预算
 */
export async function autoCompact(
  messages: ChatMessage[],
  provider: ProviderConfig,
  modelOverride?: string,
  uiMessages?: UIMessage[],
  contextWindow?: number
): Promise<CompactResult> {
  // 分离 system 消息和对话消息
  const systemMsgs: ChatMessage[] = []
  const conversationMsgs: ChatMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMsgs.push(msg)
    } else {
      conversationMsgs.push(msg)
    }
  }

  if (conversationMsgs.length <= 4) {
    log('info', 'Auto compact: not enough messages to compress')
    return { messages, info: { beforeTokens: 0, afterTokens: 0, compressedCount: 0, keptCount: conversationMsgs.length } }
  }

  // 按 token 预算规划切分（Cline 风格）
  const cw = contextWindow || getContextWindow(provider, modelOverride)
  const preserveBudget = getPreserveTokenBudget(cw)
  const { toCompress, toKeep } = planCompactByTokens(conversationMsgs, preserveBudget, estimateMessageTokens)
  if (toCompress.length === 0) {
    log('info', 'Auto compact: no safe boundary to split, skipping')
    return { messages, info: { beforeTokens: 0, afterTokens: 0, compressedCount: 0, keptCount: conversationMsgs.length } }
  }

  // 与 toKeep 对应的原始 UI 消息（toKeep 是 conversationMsgs 的后缀，
  // uiMessages 与 conversationMsgs 同序（排除 system），取尾部即可）
  const keptUiMessages = uiMessages?.filter(m => m.role !== 'system').slice(-toKeep.length)

  log('info', `Auto compact: compressing ${toCompress.length} messages, keeping ${toKeep.length} recent (budget=${preserveBudget} tokens)`)

  const summaryInput = toCompress.map(m => {
    let text = `[${m.role}]`
    if (m.name) text += ` (${m.name})`
    if (m.content) {
      if (Array.isArray(m.content)) {
        // 多模态 content：提取文本部分，图片标记为 [image]
        const imageCount = m.content.filter(part => part.type === 'image_url').length
        const textPart = extractTextContent(m.content)
        if (textPart) text += `: ${truncateForSummary(textPart, m.role === 'tool' ? TOOL_RESULT_CHAR_LIMIT : MAX_SINGLE_MSG_CHARS)}`
        if (imageCount > 0) text += `: [${imageCount} image(s)]`
      } else {
        const limit = m.role === 'tool' ? TOOL_RESULT_CHAR_LIMIT : MAX_SINGLE_MSG_CHARS
        text += `: ${truncateForSummary(m.content, limit)}`
      }
    }
    if (m.tool_calls && m.tool_calls.length > 0) {
      text += ` [Tool calls: ${m.tool_calls.map(tc => `${tc.function.name}(${tc.function.arguments.slice(0, 100)})`).join(', ')}]`
    }
    return text
  }).join('\n\n')

  const summaryPrompt: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a conversation summarizer. Summarize the following conversation history concisely, preserving key context, decisions, file paths, code snippets, and important findings. Output a single paragraph summary. Do not include pleasantries. Be specific about technical details.'
    },
    {
      role: 'user',
      content: `Summarize this conversation history:\n\n${summaryInput}`
    }
  ]

  try {
    const summary = await complete(provider, summaryPrompt, modelOverride, 800)
    log('info', `Auto compact: summary generated (${summary.length} chars)`)

    const compactedMessages: ChatMessage[] = [
      ...systemMsgs,
      {
        role: 'user',
        content: `${COMPACT_SUMMARY_PREFIX}\n${summary}`
      },
      ...toKeep
    ]

    const beforeTokens = estimateTokens([...systemMsgs, ...conversationMsgs])
    const afterTokens = estimateTokens(compactedMessages)
    log('info', `Auto compact: ${beforeTokens} → ${afterTokens} tokens (saved ${beforeTokens - afterTokens})`)

    return {
      messages: compactedMessages,
      info: { beforeTokens, afterTokens, compressedCount: toCompress.length, keptCount: toKeep.length },
      keptUiMessages
    }
  } catch (err) {
    log('error', `Auto compact failed: ${(err as Error).message}`)
    const fallback: ChatMessage[] = [...systemMsgs, ...toKeep]
    log('warn', 'Auto compact: falling back to simple truncation')
    return {
      messages: fallback,
      info: { beforeTokens: estimateTokens([...systemMsgs, ...conversationMsgs]), afterTokens: estimateTokens(fallback), compressedCount: toCompress.length, keptCount: toKeep.length },
      keptUiMessages
    }
  }
}
