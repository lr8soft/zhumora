interface ContextDetectionConfig {
  baseUrl: string
  apiKey: string
  contextWindow?: number
}

export function configuredContextWindow(provider: ContextDetectionConfig, useConfiguredValue: boolean): number | null {
  return useConfiguredValue && provider.contextWindow && provider.contextWindow > 0
    ? provider.contextWindow
    : null
}

/**
 * 探测结果是否应写回 contextWindow 配置字段。
 * 显式手动值（contextWindow > 0）优先于探测（TECHNICAL.md）：
 * 后台/隐式探测（requested=false）绝不覆盖手动值，只有用户显式点击
 * "重新探测"（requested=true）才允许写回。
 */
export function shouldApplyDetectedContextWindow(
  current: { contextWindow?: number },
  requested: boolean
): boolean {
  const hasManualValue = (current.contextWindow ?? 0) > 0
  return requested || !hasManualValue
}

export function contextDetectionCacheKey(provider: ContextDetectionConfig, model: string): string {
  return `${provider.baseUrl}::${model}::${provider.apiKey ? 'authenticated' : 'anonymous'}`
}

/**
 * 从 /models 的单个条目里提取上下文长度（多种字段命名兼容）。
 * 按"首个正值"取用，不区分后端类型：
 * - llama.cpp: meta.n_ctx
 * - vLLM / SGLang: max_model_len（/v1/models 模型卡片上的服务端上下文上限，
 *   即模型实际生效的上下文窗口，单位 token；LoRA 适配器该字段为 null）
 * - OpenRouter / 部分网关: context_length / max_context_length / limit_context /
 *   contextLength / max_input_tokens
 * DeepSeek / GLM / OpenAI 官方 /models 不携带任何上下文字段，返回 null 后由
 * 模型名启发式表兜底，这是预期行为。
 */
export function pickContextLength(entry: any): number | null {
  if (!entry) return null
  const candidates = [
    entry.meta?.n_ctx,
    entry.max_model_len,
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
