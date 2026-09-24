// ============================================================
// 思考强度能力探测 — IO 边界
//
// 纯解码在 reasoning.ts（可 node 单测）；这里只负责请求与返回。
// 探测结果只用于设置页如实展示，不参与 Agent 运行路径，因此不设进程内缓存：
// 每次调用都是一次本地/近端 GET（设置页在编辑停滞后触发），避免再引入一份
// 需要说明失效条件的缓存状态。llama.cpp 之外的端点 404，返回"未声明"。
// ============================================================
import type { ProviderConfig, ReasoningCapability } from '../../shared/types'
import { getFetch } from '../net/fetch'
import { log } from './logger'
import { decodeReasoningCapability, UNKNOWN_REASONING_CAPABILITY } from './reasoning'

/** 与上下文窗口探测一致的超时：本地服务毫秒级，远端网关留余量 */
const PROBE_TIMEOUT_MS = 5_000

/**
 * 探测端点是否声明接受思考强度控制。
 * 只查 llama.cpp 的 `GET /props`（`chat_template_caps` 的唯一来源）；
 * 未部署该端点的服务返回 404 → "未声明"。不抛异常。
 */
export async function probeReasoningCapability(
  provider: ProviderConfig,
  modelOverride?: string
): Promise<ReasoningCapability> {
  const baseUrl = (provider.baseUrl || '').replace(/\/$/, '')
  if (!baseUrl) return UNKNOWN_REASONING_CAPABILITY
  const root = baseUrl.replace(/\/v1$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`

  for (const url of [`${root}/props`, `${root}/v1/props`]) {
    try {
      const resp = await getFetch()(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!resp.ok) continue
      const capability = decodeReasoningCapability(await resp.json())
      log('info', `Reasoning capability for ${provider.name || baseUrl}${modelOverride ? ` (${modelOverride})` : ''}: ${JSON.stringify(capability)}`)
      return capability
    } catch {
      // 端点不提供 /props（vLLM / SGLang / LiteLLM / 商用 API）属预期情况
    }
  }
  return UNKNOWN_REASONING_CAPABILITY
}
