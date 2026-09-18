import type { Session, SessionOrigin } from '@shared/types'

/**
 * 侧边栏会话分组纯投影（不进 store、不新增持久化状态）。
 * 分组维度是会话来源 origin（store 从 bot_sessions 派生）：
 * Telegram / QQ / MCP 的外部会话与桌面会话分开，避免混在同一个列表里。
 */
export interface SessionGroup {
  origin: SessionOrigin
  sessions: Session[]
}

const GROUP_ORDER: SessionOrigin[] = ['renderer', 'telegram', 'qq', 'mcp']

export function groupSessionsByOrigin(sessions: Session[]): SessionGroup[] {
  const byOrigin = new Map<SessionOrigin, Session[]>()
  for (const session of sessions) {
    const list = byOrigin.get(session.origin)
    if (list) list.push(session)
    else byOrigin.set(session.origin, [session])
  }
  // 空分组不渲染；组内保持 store 的 updatedAt 降序
  return GROUP_ORDER
    .filter(origin => byOrigin.has(origin))
    .map(origin => ({ origin, sessions: byOrigin.get(origin)! }))
}
