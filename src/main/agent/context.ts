// ============================================================
// 上下文管理 — Token 估算 + Auto Compact + 上下文窗口探测
//
// 关键设计（对齐 Cline / opencode）：
// 压缩只影响"发给 LLM 的上下文"，绝不删除/改写数据库里的消息。
// 用户侧始终能看到完整历史。压缩状态持久化为一条记录：
//   { upToMessageId, summary }  —— upToMessageId 之前的消息在构建
//   LLM 上下文时被 summary 替换，之后的消息原样保留。
// 多次压缩是增量的：新摘要会把旧摘要一并折叠进去。
// ============================================================
import { extractTextContent } from '../../shared/multimodal'
import type { ChatMessage, ProviderConfig } from '../../shared/types'
import { COMPACT_SUMMARY_PREFIX } from '../../shared/types'
import { complete } from '../llm/provider'
import { getFetch } from '../net/fetch'
import { log } from '../llm/logger'
import { planCompactByTokens } from './history'

// 默认上下文窗口（API 未返回、启发式也未命中时的 fallback）
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

// ============================================================
// 上下文窗口探测
// ============================================================

/**
 * 已知模型的上下文窗口启发式表（API 未报告时的兜底）。
 * 键用小写子串匹配（对 defaultModel 做 includes 判断）。
 * 值单位为 token。宁可给一个合理的上限，也绝不返回 0/"不限制"。
 */
const MODEL_CONTEXT_HEURISTICS: Array<[pattern: string, tokens: number]> = [
  // OpenAI
  ['o1-preview', 128000],
  ['o1-mini', 128000],
  ['o1', 200000],
  ['o3-mini', 200000],
  ['o3', 200000],
  ['o4-mini', 200000],
  ['gpt-4o-mini', 128000],
  ['gpt-4o', 128000],
  ['gpt-4-turbo', 128000],
  ['gpt-4.1-mini', 128000],
  ['gpt-4.1', 128000],
  ['gpt-4', 128000],
  ['gpt-3.5-turbo-16k', 16385],
  ['gpt-3.5-turbo', 16385],
  // Anthropic
  ['claude-sonnet-4', 200000],
  ['claude-opus-4', 200000],
  ['claude-3-7-sonnet', 200000],
  ['claude-3-5-sonnet', 200000],
  ['claude-3-5-haiku', 200000],
  ['claude-3-opus', 200000],
  ['claude-3-haiku', 200000],
  // Google
  ['gemini-2.5', 1048576],
  ['gemini-2.0', 1048576],
  ['gemini-1.5-pro', 1048576],
  ['gemini-1.5-flash', 1048576],
  ['gemini-pro', 1048576],
  ['gemini-flash', 1048576],
  // DeepSeek
  ['deepseek-reasoner', 65536],
  ['deepseek-chat', 65536],
  ['deepseek-v3', 65536],
  ['deepseek', 65536],
  // Qwen
  ['qwen2.5-coder', 131072],
  ['qwen3', 131072],
  ['qwen-max', 32768],
  ['qwen-plus', 131072],
  ['qwen', 131072],
  // 通用大模型
  ['llama-4', 1048576],
  ['llama-3.1-405b', 131072],
  ['llama-3.1', 131072],
  ['llama-3', 131072],
  ['mistral-large', 131072],
  ['mistral', 32768],
  ['mixtral', 32768],
  ['glm-4', 131072],
  ['glm', 131072],
  ['yi-34b', 16384],
  ['command-r', 131072]
]

/** 根据模型名匹配启发式表，命中返回 token 数，否则 null */
export function heuristicContextWindow(model: string): number | null {
  if (!model) return null
  const m = model.toLowerCase()
  // 更长的 pattern 优先（避免 'o1' 抢先匹配 'o3'）
  const sorted = [...MODEL_CONTEXT_HEURISTICS].sort((a, b) => b[0].length - a[0].length)
  for (const [pattern, tokens] of sorted) {
    if (m.includes(pattern)) return tokens
  }
  return null
}

/**
 * 从 API 动态获取模型的上下文窗口大小
 *
 * 尝试顺序：
 * 1. 用户在 ProviderConfig.contextWindow 手动配置 → 直接使用
 * 2. GET /v1/models → 匹配模型名的条目：meta.n_ctx（llama.cpp）/
 *    context_length（OpenRouter 等）/ max_context_length / limit_context
 * 3. GET /props → default_generation_settings.n_ctx（llama.cpp 专有端点）
 * 4. POST /api/show → model_info.<arch>.context_length（Ollama 专有端点，按模型名精确匹配）
 * 5. 模型名启发式表（常见商用模型）
 * 6. 以上都失败 → DEFAULT_CONTEXT_WINDOW（保守兜底，绝不返回 0）
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

  // 尝试 1: GET /models — 精确匹配模型名（不再盲取 models[0]）
  // llama.cpp: data[].meta.n_ctx；OpenRouter/部分网关: data[].context_length
  try {
    const resp = await getFetch()(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(5000) })
    if (resp.ok) {
      const json: any = await resp.json()
      const models = json.data || json.models
      if (Array.isArray(models) && models.length > 0) {
        // 优先找与 model 完全一致或后缀匹配的条目
        const target =
          models.find(mm => mm.id === model) ||
          models.find(mm => typeof mm.id === 'string' && mm.id.toLowerCase().includes(model.toLowerCase())) ||
          models.find(mm => typeof model === 'string' && model.toLowerCase().includes(mm.id.toLowerCase())) ||
          models[0]
        nCtx = pickContextLength(target)
        if (nCtx) log('info', `Context window from /models (${target.id || models[0].id}): ${nCtx}`)
      }
    }
  } catch {
    // 忽略，继续尝试下一个端点
  }

  // 尝试 2: GET /props — llama.cpp 专有端点
  if (nCtx === null) {
    for (const propsUrl of [`${baseUrl.replace(/\/v1$/, '')}/props`, `${baseUrl.replace(/\/v1$/, '')}/v1/props`]) {
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
  }

  // 尝试 3: POST /api/show — Ollama 专有端点（按模型名精确匹配）
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

  // 尝试 4: 模型名启发式表
  if (nCtx === null) {
    const heuristic = heuristicContextWindow(model)
    if (heuristic) {
      nCtx = heuristic
      log('info', `Context window from heuristic for "${model}": ${nCtx}`)
    }
  }

  if (nCtx !== null && nCtx > 0) {
    contextWindowCache.set(cacheKey, nCtx)
    return nCtx
  }

  log('warn', `Could not detect context window for ${model} at ${baseUrl}, using default ${DEFAULT_CONTEXT_WINDOW}`)
  contextWindowCache.set(cacheKey, DEFAULT_CONTEXT_WINDOW)
  return DEFAULT_CONTEXT_WINDOW
}

/** 从 /models 的单个条目里提取上下文长度（多种字段命名兼容） */
function pickContextLength(entry: any): number | null {
  if (!entry) return null
  const candidates = [
    entry.meta?.n_ctx,
    entry.context_length,
    entry.max_context_length,
    entry.limit_context,
    entry.contextLength,
    entry.max_input_tokens
  ]
  for (const c of candidates) {
    if (typeof c === 'number' && c > 0) return Math.floor(c)
  }
  return null
}

/**
 * 获取上下文窗口大小（同步版本，使用缓存 / 手动配置 / 启发式 / 默认）
 * 首次调用前应先调用 fetchContextWindow 以填充缓存
 */
export function getContextWindow(provider: ProviderConfig, modelOverride?: string): number {
  if (provider.contextWindow && provider.contextWindow > 0) {
    return provider.contextWindow
  }
  const model = modelOverride || provider.defaultModel
  const cacheKey = `${provider.baseUrl}::${model}`
  const cached = contextWindowCache.get(cacheKey)
  if (cached) return cached
  return heuristicContextWindow(model) ?? DEFAULT_CONTEXT_WINDOW
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
      for (const part of msg.content) {
        if (part.type === 'text') {
          tokens += estimateTextTokens(part.text)
        } else if (part.type === 'image_url') {
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

/** 估算消息列表的 token 数（CJK 感知） */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateMessageTokens(m)
  return total
}

/**
 * 检查是否需要触发 auto compact
 * 阈值 = contextWindow × INPUT_RATIO(0.9) × TRIGGER_RATIO(0.9) = 81%
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

// ============================================================
// 压缩核心 — 只生成摘要 + 边界，不触碰数据库
//
// 注：buildEffectiveConversation 与 CompactionState（纯函数/类型）定义在 ./history，
// 便于单元测试；本文件顶部已 import 并再导出。
// ============================================================

/** 截断超长文本用于摘要输入 */
function truncateForSummary(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`
}

/** 把待压缩消息序列化为摘要输入文本（工具结果 / 单条文本各自截断） */
function toSummaryInput(toCompress: ChatMessage[]): string {
  return toCompress.map(m => {
    let text = `[${m.role}]`
    if (m.name) text += ` (${m.name})`
    if (m.content) {
      if (Array.isArray(m.content)) {
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
}

/** 调用 LLM 生成摘要（增量压缩时输入里含旧摘要，会被一并折叠） */
async function generateSummary(toCompress: ChatMessage[], provider: ProviderConfig, modelOverride?: string): Promise<string | null> {
  const summaryInput = toSummaryInput(toCompress)
  const summaryPrompt: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a conversation summarizer. Summarize the following conversation history concisely, preserving key context, decisions, file paths, code snippets, and important findings. If the input already contains a prior "[Auto Compact Summary]", fold it into the new summary. Output a single paragraph summary. Do not include pleasantries. Be specific about technical details.'
    },
    {
      role: 'user',
      content: `Summarize this conversation history:\n\n${summaryInput}`
    }
  ]
  try {
    const summary = await complete(provider, summaryPrompt, modelOverride, 800)
    log('info', `Auto compact: summary generated (${summary.length} chars)`)
    return summary
  } catch (err) {
    log('error', `Auto compact: summary generation failed: ${(err as Error).message}`)
    return null
  }
}

/**
 * 规划 + 执行一次 auto compact（纯函数，不写库）。
 *
 * 输入是"当前发给 LLM 的对话上下文"（effective，可能以旧摘要开头），
 * 输出新的摘要文本 + 保留段（toKeep，effective 的后缀）+ toKeep 在
 * effective 中的起点下标 keptOffset。调用方据此把新边界映射回完整
 * 历史（keptFromIndex + keptOffset）并持久化 CompactionState。
 *
 * @returns
 *   summary          新生成的摘要（LLM 失败时为 null，调用方退化为截断）
 *   toKeep           保留的最近消息（effective 的后缀）
 *   keptOffset       toKeep 在 effective 中的起始下标
 *   beforeTokens     压缩前 token 估算
 *   afterTokens      压缩后 token 估算
 *   compressedCount  被折叠进摘要的消息条数
 *   keptCount        保留的消息条数
 */
export async function planAutoCompact(
  effective: ChatMessage[],
  provider: ProviderConfig,
  modelOverride?: string,
  contextWindow?: number
): Promise<{
  summary: string | null
  toKeep: ChatMessage[]
  keptOffset: number
  beforeTokens: number
  afterTokens: number
  compressedCount: number
  keptCount: number
}> {
  const cw = contextWindow && contextWindow > 0
    ? contextWindow
    : getContextWindow(provider, modelOverride)
  const preserveBudget = getPreserveTokenBudget(cw)
  const { toCompress, toKeep } = planCompactByTokens(effective, preserveBudget, estimateMessageTokens)
  const keptOffset = toCompress.length

  if (toCompress.length === 0) {
    return {
      summary: null,
      toKeep: effective,
      keptOffset: 0,
      beforeTokens: estimateTokens(effective),
      afterTokens: estimateTokens(effective),
      compressedCount: 0,
      keptCount: effective.length
    }
  }

  log('info', `Auto compact: compressing ${toCompress.length} messages, keeping ${toKeep.length} recent (budget=${preserveBudget} tokens)`)

  const beforeTokens = estimateTokens(effective)
  const summary = await generateSummary(toCompress, provider, modelOverride)

  // LLM 失败 → 退化为截断（丢弃旧摘要与新消息，只保留 toKeep），
  // 摘要文本置 null：调用方持久化时保留旧摘要或写一个占位。
  const afterTokens = summary
    ? estimateTokens([{ role: 'user', content: `${COMPACT_SUMMARY_PREFIX}\n${summary}` }, ...toKeep])
    : estimateTokens(toKeep)

  log('info', `Auto compact: ${beforeTokens} → ${afterTokens} tokens (saved ${beforeTokens - afterTokens})`)

  return {
    summary,
    toKeep,
    keptOffset,
    beforeTokens,
    afterTokens,
    compressedCount: toCompress.length,
    keptCount: toKeep.length
  }
}

/** 构造摘要消息（role=user，带固定前缀供 UI 识别渲染为折叠摘要块） */
export function makeSummaryMessage(summary: string): ChatMessage {
  return { role: 'user', content: `${COMPACT_SUMMARY_PREFIX}\n${summary}` }
}
