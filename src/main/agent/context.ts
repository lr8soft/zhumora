// ============================================================
// 上下文窗口探测与有界元数据缓存。
// Token 预算在 contextBudget，历史摘要规划在 compaction；请求复检由 AutoCompactor 负责。
// ============================================================
import { createProviderRequestHeaders } from '../../shared/providerHeaders'
import type { ProviderConfig } from '../../shared/types'
import { getFetch } from '../net/fetch'
import { log } from '../llm/logger'
import { configuredContextWindow, contextDetectionCacheKey, pickContextLength } from './contextDetectionPolicy'

// 默认上下文窗口（API 未返回、启发式也未命中时的 fallback）
const DEFAULT_CONTEXT_WINDOW = 32768

// 缓存：endpoint + model + 有效请求头 → contextWindow；配置变化自然失效。
// 与现有生命周期一致，应用退出释放；forceRefresh 绕过缓存。
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
 *    max_model_len（vLLM / SGLang）/ context_length（OpenRouter 等）/
 *    max_context_length / limit_context
 * 3. GET /props → default_generation_settings.n_ctx（llama.cpp 专有端点）
 * 4. POST /api/show → model_info.<arch>.context_length（Ollama 专有端点，按模型名精确匹配）
 * 5. 模型名启发式表（常见商用模型）
 * 6. 以上都失败 → DEFAULT_CONTEXT_WINDOW（保守兜底，绝不返回 0）
 */
async function resolveContextWindow(
  provider: ProviderConfig,
  modelOverride: string | undefined,
  options: { useConfiguredValue: boolean; forceRefresh: boolean }
): Promise<number> {
  const configured = configuredContextWindow(provider, options.useConfiguredValue)
  if (configured !== null) return configured
  const model = modelOverride || provider.defaultModel
  const cacheKey = contextDetectionCacheKey(provider, model)
  if (!options.forceRefresh && contextWindowCache.has(cacheKey)) {
    return contextWindowCache.get(cacheKey)!
  }

  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  const headers = createProviderRequestHeaders(provider)

  let nCtx: number | null = null

  // 尝试 1: GET /models — 精确匹配模型名（不再盲取 models[0]）
  // llama.cpp: data[].meta.n_ctx；vLLM / SGLang: data[].max_model_len；
  // OpenRouter/部分网关: data[].context_length
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

/** Agent 运行时入口：显式配置优先，否则使用探测/缓存/启发式结果。 */
export function fetchContextWindow(provider: ProviderConfig, modelOverride?: string): Promise<number> {
  return resolveContextWindow(provider, modelOverride, { useConfiguredValue: true, forceRefresh: false })
}

/** 设置页探测入口：忽略当前手动值并绕过缓存，读取端点此刻报告的真实窗口。 */
export function detectProviderContextWindow(provider: ProviderConfig, modelOverride?: string): Promise<number> {
  return resolveContextWindow(provider, modelOverride, { useConfiguredValue: false, forceRefresh: true })
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
  const cacheKey = contextDetectionCacheKey(provider, model)
  const cached = contextWindowCache.get(cacheKey)
  if (cached) return cached
  return heuristicContextWindow(model) ?? DEFAULT_CONTEXT_WINDOW
}
