// ============================================================
// 工作对话上下文 — "当前发给 LLM 的消息数组" + 平行对齐的持久化 id
//
// 不变量（AGENTS.MD）：
// - index 0 恒为 system 消息，ids[0] 恒为 null；
// - 虚拟摘要位（压缩产生的合成消息）id 为 null；
// - 任何消息增删都必须同时作用于两个数组，保证下标对齐
//   —— 压缩边界定位依赖这个对齐，禁止在别处复制这套映射。
// ============================================================
import type { ChatMessage } from '../../shared/types'

export class WorkingConversation {
  readonly messages: ChatMessage[] = []
  /** 与 messages 平行对齐的 DB 消息 id；虚拟位（system / 摘要 / 注入指令）= null */
  readonly ids: Array<string | null> = []

  constructor(systemPrompt: string) {
    this.messages.push({ role: 'system', content: systemPrompt })
    this.ids.push(null)
  }

  /** 追加一条真实消息（assistant / tool）。id = 落库 id，未落库传 null */
  append(message: ChatMessage, id: string | null): void {
    this.messages.push(message)
    this.ids.push(id)
  }

  /** 追加一条仅存在于工作上下文的合成 user 指令（恢复引导等），无持久化 id */
  appendSyntheticUser(content: string): void {
    this.messages.push({ role: 'user', content })
    this.ids.push(null)
  }

  /**
   * 以"摘要 + 保留段"重建 system 之后的全部消息（auto compact 用）。
   * tailIds 与 tail 平行对齐（虚拟摘要位 = null）。
   */
  replaceAfterSystem(tail: ChatMessage[], tailIds: Array<string | null>): void {
    const system = this.messages[0]
    const systemId = this.ids[0]
    this.messages.length = 0
    this.ids.length = 0
    this.messages.push(system)
    this.ids.push(systemId)
    for (let i = 0; i < tail.length; i++) {
      this.messages.push(tail[i])
      this.ids.push(tailIds[i] ?? null)
    }
  }

  /** system 之后的有效对话（不含 system） */
  effective(): ChatMessage[] {
    return this.messages.slice(1)
  }

  /** 有效对话对应的 id（与 effective() 平行对齐） */
  effectiveIds(): Array<string | null> {
    return this.ids.slice(1)
  }
}
