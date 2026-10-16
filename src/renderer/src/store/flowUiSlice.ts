// 画布视图偏好的 renderer 持久化（localStorage，跨会话切换与重启保留）。
// 与 theme / sidebarWidth / approveMode 同一模式：模块级 getStored* 读默认值 +
// setter 内联实时写回，无防抖、无统一封装。不进入 SettingsDraft（不在设置页编辑）。
// “自动跟随”与镜头缩放/跟随是运行时相机状态，故意不持久化（边界见 ARCHITECTURE.md）。
export const FLOW_FOLD_HISTORY_KEY = 'zhumora.flowFoldHistory'
export const FLOW_SHOW_CHILDREN_KEY = 'zhumora.flowShowChildren'
export const FLOW_EXPANDED_TURNS_KEY = 'zhumora.flowExpandedTurns'

/** 单会话最多记忆多少个“已单独展开的折叠轮次”，防止 localStorage 无限增长。 */
const MAX_EXPANDED_TURNS_PER_SESSION = 200

type ExpandedTurnsMap = Record<string, string[]>

export interface FlowUiSlice {
  /** 历史折叠总开关（全局）。true = 折叠旧轮次（仅最后一轮默认展开）。 */
  flowFoldHistory: boolean
  setFlowFoldHistory: (value: boolean) => void
  /** 子任务分支显示开关（全局）。true = 显示委托分支。 */
  flowShowChildren: boolean
  setFlowShowChildren: (value: boolean) => void
  /** 已单独展开的折叠轮次，按会话隔离（sessionId → turnId 列表）。 */
  flowExpandedTurns: Readonly<Record<string, readonly string[]>>
  /** 记录某会话单独展开的一个折叠轮次（去重；超上限丢弃最早的）。 */
  expandFlowTurn: (sessionId: string, turnId: string) => void
  /** 移除某会话的单独展开轮次：折叠总开关切换时重置，删除会话时清理。 */
  clearFlowExpandedTurns: (sessionId: string) => void
}

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key)
    return stored === null ? fallback : stored === '1'
  } catch {
    return fallback
  }
}

function readExpandedTurns(): ExpandedTurnsMap {
  try {
    const raw = localStorage.getItem(FLOW_EXPANDED_TURNS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const map: ExpandedTurnsMap = {}
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) map[sessionId] = value.filter(id => typeof id === 'string')
    }
    return map
  } catch {
    return {}
  }
}

function persist(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* ignore */ }
}

export function createFlowUiSlice(
  set: (partial: Partial<FlowUiSlice>) => void,
  get: () => FlowUiSlice
): FlowUiSlice {
  const writeExpandedTurns = (next: ExpandedTurnsMap): void => {
    set({ flowExpandedTurns: next })
    persist(FLOW_EXPANDED_TURNS_KEY, JSON.stringify(next))
  }
  return {
    flowFoldHistory: readBoolean(FLOW_FOLD_HISTORY_KEY, true),
    setFlowFoldHistory: value => {
      set({ flowFoldHistory: value })
      persist(FLOW_FOLD_HISTORY_KEY, value ? '1' : '0')
    },
    flowShowChildren: readBoolean(FLOW_SHOW_CHILDREN_KEY, true),
    setFlowShowChildren: value => {
      set({ flowShowChildren: value })
      persist(FLOW_SHOW_CHILDREN_KEY, value ? '1' : '0')
    },
    flowExpandedTurns: readExpandedTurns(),
    expandFlowTurn: (sessionId, turnId) => {
      const current = get().flowExpandedTurns[sessionId] ?? []
      const next = [...current.filter(id => id !== turnId), turnId]
      while (next.length > MAX_EXPANDED_TURNS_PER_SESSION) next.shift()
      writeExpandedTurns({ ...get().flowExpandedTurns, [sessionId]: next })
    },
    clearFlowExpandedTurns: sessionId => {
      const map = get().flowExpandedTurns
      if (!(sessionId in map)) return
      const next = { ...map }
      delete next[sessionId]
      writeExpandedTurns(next)
    }
  }
}
