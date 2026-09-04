// ============================================================
// 会话自动命名兜底 — LLM 未调用 set_title 时补齐标题
//
// 背景：系统提示词只是"建议"LLM 调 set_title，模型经常不调，
// 侧边栏就永远停在 "New Session"。这里在每次运行结束后检查：
// 标题仍是默认值 → 用 complete()（小请求）根据首条用户消息
// 生成标题并落库。set_title 与这里的写入共享 title_updated 事件。
//
// completeFn 由调用方注入（provider 依赖 electron，测试传 fake）。
// ============================================================
import type { ChatMessage, ProviderConfig } from '../../shared/types'
import { log } from '../llm/logger.ts'
import { extractTextContent } from '../../shared/multimodal.ts'
import { sanitizeSessionTitle, sessionNeedsTitle } from '../../shared/sessionTitle.ts'

export interface FallbackTitleStore {
  getSessionTitle(sessionId: string): string | null
  applyGeneratedTitle(sessionId: string, title: string): void
}

export interface EnsureSessionTitleOptions {
  provider: ProviderConfig
  sessionId: string
  /** 会话内全部用户消息文本（时间升序） */
  userTexts: string[]
  store: FallbackTitleStore
  completeFn: (provider: ProviderConfig, messages: ChatMessage[], model?: string, maxTokens?: number) => Promise<string>
  modelOverride?: string
}

/**
 * 标题仍是默认值时生成并应用一次。所有失败静默（标题是装饰性
 * 功能，不能影响主流程）；并发/重复写入由 store 层的条件更新兜底。
 */
export async function ensureSessionTitle(options: EnsureSessionTitleOptions): Promise<void> {
  const { provider, sessionId, store } = options
  try {
    const current = store.getSessionTitle(sessionId)
    if (current === null) return
    // set_title 已经生效（或用户手动改名）→ 不覆盖
    if (!sessionNeedsTitle(current)) return

    const seed = options.userTexts.find(text => text.trim())?.trim().slice(0, 600)
    if (!seed) return

    const raw = await options.completeFn(
      provider,
      [
        {
          role: 'system',
          content: 'You name conversations. Reply with ONLY a short title (max 6 words) that summarizes the user request. Use the same language as the request. No quotes, no trailing punctuation, no explanation.'
        },
        { role: 'user', content: seed }
      ],
      options.modelOverride,
      32
    )
    const title = sanitizeSessionTitle(raw)
    if (!title) return
    store.applyGeneratedTitle(sessionId, title)
    log('info', `Auto-generated session title: "${title}" (sessionId=${sessionId})`)
  } catch (err) {
    log('warn', `Auto session title failed (sessionId=${sessionId}): ${(err as Error).message}`)
  }
}

/** 从消息列表里取出用户消息文本（时间升序，多模态取文本部分） */
export function collectUserTexts(messages: Array<{ role: string; content: ChatMessage['content'] }>): string[] {
  return messages
    .filter(m => m.role === 'user')
    .map(m => extractTextContent(m.content))
}
