// ============================================================
// 会话标题 — 默认标题判断与 LLM 生成结果清洗（纯函数，可单测）
// ============================================================

export const DEFAULT_SESSION_TITLE = 'New Session'
export const SESSION_TITLE_MAX_CHARS = 50
export const SESSION_TITLE_MAX_WORDS = 6

/**
 * 会话仍为默认标题时注入系统提示词的提醒。
 * 每轮运行都注入（而不是只在首轮），LLM 错过一次不会永远错过——
 * 标题被 set_title 更新后 needsTitle 变 false，提醒随之消失。
 */
export const SESSION_TITLE_REMINDER = `## Session Title Reminder
This session still has its default title. On your NEXT response, include a set_title tool call alongside your other tool calls (or as the only call if no work is needed). Use the same language as the user's message. Once the title is set, this reminder disappears.`

/** 标题仍是默认值（或为空）→ 需要 LLM 命名 / client 提醒 */
export function sessionNeedsTitle(title: string | null | undefined): boolean {
  const trimmed = (title || '').trim()
  return trimmed === '' || trimmed === DEFAULT_SESSION_TITLE
}

/**
 * 清洗 LLM 返回的标题：取首行、去掉包裹引号与结尾标点、
 * 收敛空白、限 6 词与 50 字符（与 set_title 工具的截断一致）。
 * 清洗后为空则返回 ''（调用方视为生成失败）。
 */
export function sanitizeSessionTitle(raw: string): string {
  const firstLine = (raw || '').replace(/```/g, '').trim().split(/\r?\n/)[0] || ''
  const cleaned = firstLine
    .replace(/^[\s"'“”‘’《【(（]+/, '')
    .replace(/[\s"'“”‘’》】).:：。!！?？]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  const words = cleaned.split(' ')
  const capped = words.length > SESSION_TITLE_MAX_WORDS ? words.slice(0, SESSION_TITLE_MAX_WORDS).join(' ') : cleaned
  const characters = Array.from(capped)
  if (characters.length <= SESSION_TITLE_MAX_CHARS) return capped
  return characters.slice(0, SESSION_TITLE_MAX_CHARS - 1).join('') + '…'
}
