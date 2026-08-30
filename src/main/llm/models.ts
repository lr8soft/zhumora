// ============================================================
// 模型列表 — OpenAI 兼容 GET {baseUrl}/models
// 供设置界面下拉选择默认模型；与 context.ts 的窗口探测互不耦合
// ============================================================
import type { ProviderConfig } from '../../shared/types'
import { getFetch } from '../net/fetch'
import { log } from './logger'

export interface ModelListItem {
  id: string
  /** 显示名（部分服务在 id 之外提供 name） */
  name?: string
  ownedBy?: string
}

export interface ListModelsResult {
  models: ModelListItem[]
  error?: string
}

/** baseUrl → 结果缓存（列表不常变，5 分钟 TTL；force 可绕过） */
const cache = new Map<string, { ts: number; result: ListModelsResult }>()
const CACHE_TTL_MS = 5 * 60 * 1000

/** 请求超时：10s（本地服务通常毫秒级，远端网关留点余量） */
const LIST_TIMEOUT_MS = 10_000

/**
 * 从 provider 拉取模型列表。
 * 兼容多种返回形状（Postel 定律）：
 * - { data: ["id1", "id2"] }                                   部分本地服务返回字符串数组
 * - { data: [{ id, name?, owned_by?, ... }] }                  标准 OpenAI / llama.cpp / vLLM
 * - { models: [...] }                                          Ollama 兼容层 / 部分网关
 * 失败不抛异常，统一返回 { models: [], error }，由 UI 决定如何提示。
 */
export async function listProviderModels(provider: ProviderConfig, force = false): Promise<ListModelsResult> {
  const baseUrl = (provider.baseUrl || '').replace(/\/$/, '')
  if (!baseUrl) return { models: [], error: 'baseUrl is empty' }

  const cached = cache.get(baseUrl)
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.result

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`

  try {
    const resp = await getFetch()(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      // 错误结果不写缓存：用户改完 key / 稍后可直接重试
      return { models: [], error: `HTTP ${resp.status}${text ? ': ' + text.slice(0, 200) : ''}` }
    }
    const json: any = await resp.json()
    const raw: unknown[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []

    const seen = new Set<string>()
    const models: ModelListItem[] = []
    for (const item of raw) {
      let entry: ModelListItem | null = null
      if (typeof item === 'string' && item) {
        entry = { id: item }
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        const id = typeof obj.id === 'string' ? obj.id : typeof obj.name === 'string' ? obj.name : typeof obj.model === 'string' ? obj.model : ''
        if (id) {
          entry = {
            id,
            name: typeof obj.name === 'string' && obj.name !== id ? obj.name : undefined,
            ownedBy: typeof obj.owned_by === 'string' ? obj.owned_by : undefined
          }
        }
      }
      if (entry && !seen.has(entry.id)) {
        seen.add(entry.id)
        models.push(entry)
      }
    }
    models.sort((a, b) => a.id.localeCompare(b.id))

    const result: ListModelsResult = { models }
    cache.set(baseUrl, { ts: Date.now(), result })
    log('info', `Listed ${models.length} models from ${baseUrl}/models`)
    return result
  } catch (err) {
    return { models: [], error: (err as Error).message }
  }
}
