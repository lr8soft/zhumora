// ============================================================
// Zustand Store — 渲染进程全局状态
//
// 会话隔离设计（对齐 opencode / Cline 的做法）：
// - 消息按会话缓存（messages: Record<sessionId, UIMessage[]>），
//   后台会话的流式事件照常累积，切回时立即可见，互不串台
// - 运行状态按会话独立（runningIds: Set<sessionId>），
//   多个会话可同时并行运行 Agent
// - 重试 / 权限请求 / 压缩通知同样按会话隔离
// ============================================================
import { create } from 'zustand'
import type { Session, UIMessage, AppSettings, AutoApproveMode, ReasoningEffort } from '@shared/types'

export type { ReasoningEffort }
import i18n, { getEffectiveLanguage, storeLanguage, type AppLanguage } from '../i18n'

const api = window.api

// ---------- 主题 / 字号 ----------
export type Theme = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'zhumora.theme'
export const FONT_SIZE_STORAGE_KEY = 'zhumora.fontSize'
/** 可选字号（px，作用于根字号，全局 rem 等比缩放） */
export const FONT_SIZE_OPTIONS = [13, 14, 15, 16, 18]
export const DEFAULT_FONT_SIZE = 15

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

function getStoredFontSize(): number {
  try {
    const stored = parseInt(localStorage.getItem(FONT_SIZE_STORAGE_KEY) || '', 10)
    return FONT_SIZE_OPTIONS.includes(stored) ? stored : DEFAULT_FONT_SIZE
  } catch {
    return DEFAULT_FONT_SIZE
  }
}

// ---------- 布局（侧边栏宽度 / 收起 / 输入区高度）----------
export const SIDEBAR_WIDTH_KEY = 'zhumora.sidebarWidth'
export const SIDEBAR_COLLAPSED_KEY = 'zhumora.sidebarCollapsed'
export const INPUT_HEIGHT_KEY = 'zhumora.inputHeight'
export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 480
export const INPUT_MIN_HEIGHT = 192
export const INPUT_MAX_HEIGHT = 480
export const DEFAULT_INPUT_HEIGHT = 0 // 0 = 自适应内容高度

function getStoredNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = parseInt(localStorage.getItem(key) || '', 10)
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
  } catch {
    return fallback
  }
}

function getStoredSidebarWidth(): number {
  return getStoredNumber(SIDEBAR_WIDTH_KEY, 224, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
}

function getStoredSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function getStoredInputHeight(): number {
  const v = getStoredNumber(INPUT_HEIGHT_KEY, DEFAULT_INPUT_HEIGHT, 0, INPUT_MAX_HEIGHT)
  // 旧版本允许存下低于最小高度的值，加载时纠正
  return v > 0 && v < INPUT_MIN_HEIGHT ? INPUT_MIN_HEIGHT : v
}

function getStoredReasoningEffort(): ReasoningEffort {
  try {
    const stored = localStorage.getItem('zhumora.reasoningEffort')
    return stored === 'off' || stored === 'low' || stored === 'medium' || stored === 'high' ? stored : 'medium'
  } catch {
    return 'medium'
  }
}

function getStoredApproveMode(): AutoApproveMode {
  try {
    const stored = localStorage.getItem('zhumora.approveMode')
    return stored === 'manual' || stored === 'auto' || stored === 'full' ? stored : 'manual'
  } catch {
    return 'manual'
  }
}

/** 设置页草稿 = AppSettings + 外观（theme/fontSize 是 localStorage 项，也纳入草稿
 *  参与 dirty/保存/取消语义，避免"只切主题时 Save 被禁用、取消被忽略"的问题） */
export interface SettingsDraft extends AppSettings {
  theme: Theme
  fontSize: number
}

export interface PermissionRequest {
  permId: string
  sessionId: string
  toolName: string
  args: Record<string, unknown>
  /** 工具权限等级（用于 UI 展示不同警告强度） */
  level?: string
}

interface RetryStatus {
  failedAttempt: number
  maxRetries: number
}

interface CompactNotice {
  beforeTokens: number
  afterTokens: number
  compressedCount: number
  keptCount: number
  error?: string
}

/** 单轮输出被 max_tokens 截断的通知（按会话，展示后自动消失） */
interface TruncatedNotice {
  /** 'tool' = 工具调用参数被截断（已要求模型拆小步重发）；'text' = 纯文本回答被截断（已自动续写） */
  kind: 'tool' | 'text'
}

/** 会话的上下文压缩标记（LLM 上下文中已折叠的边界；消息表不变，完整历史仍可见） */
interface CompactionMarker {
  /** 该消息（含）之前的历史在发给 LLM 时被摘要折叠 */
  upToMessageId: string
  summary?: string
}

/** loadMessages 进行中的去重（避免同一会话的并发拉取互相覆盖） */
const loadingMessages = new Map<string, Promise<void>>()

interface AppState {
  // 视图
  view: 'chat' | 'settings'
  setView: (v: 'chat' | 'settings') => void

  // 布局
  /** 侧边栏宽度（px）；collapsed 时不生效 */
  sidebarWidth: number
  setSidebarWidth: (px: number) => void
  /** 侧边栏收起状态 */
  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean) => void
  /** 输入区固定高度（px）；0 = 自适应内容高度 */
  inputAreaHeight: number
  setInputAreaHeight: (px: number) => void

  // 主题（light/dark/system，system 跟随系统）
  theme: Theme
  setTheme: (t: Theme) => void
  // 字号（px，根字号）
  fontSize: number
  setFontSize: (n: number) => void

  // 会话
  sessions: Session[]
  activeSessionId: string | null
  setActiveSession: (id: string) => void
  loadSessions: () => Promise<void>
  createSession: () => Promise<void>
  deleteSession: (id: string) => Promise<void>
  /** 待删除会话的 id（null = 无删除确认弹窗） */
  pendingDeleteId: string | null
  /** 弹出删除确认（不直接删，防误操作） */
  requestDeleteSession: (id: string) => void
  /** 确认删除弹窗里的会话 */
  confirmDeleteSession: () => Promise<void>
  /** 关闭删除确认弹窗 */
  cancelDeleteSession: () => void

  // 消息 — 按会话缓存（sessionId → 消息数组），未打开过的会话没有缓存
  messages: Record<string, UIMessage[]>
  loadMessages: (sessionId: string) => Promise<void>
  // 压缩标记 — 按会话缓存（sessionId → 边界）；null/无条目 = 该会话未压缩
  compactionMarkers: Record<string, CompactionMarker | null>
  loadCompaction: (sessionId: string) => Promise<void>

  // Agent 状态 — 按会话隔离，支持多会话并行
  runningIds: Set<string>
  markRunning: (sessionId: string, running: boolean) => void
  /** LLM 网络重试状态（按会话；无条目 = 该会话未在重试）；maxRetries = -1 表示无限 */
  retryStatus: Record<string, RetryStatus>
  setRetryStatus: (sessionId: string, status: RetryStatus | null) => void

  // 模型选择 — 格式为 "providerId::modelName"，null 则用 active provider 默认模型
  selectedProviderModel: string | null
  setSelectedProviderModel: (v: string | null) => void

  // 批准模式（三档：manual / auto / full）
  approveMode: AutoApproveMode
  setApproveMode: (v: AutoApproveMode) => void

  // 对话级思考强度（聊天输入框选择；off = 不发送 reasoning_effort）
  reasoningEffort: ReasoningEffort
  setReasoningEffort: (v: ReasoningEffort) => void

  // 权限 — 按会话隔离（多个并行会话可能同时弹窗，UI 按 FIFO 逐个确认）
  permissionRequests: Record<string, PermissionRequest>
  respondPermission: (allowed: boolean) => void

  // 上下文压缩通知（按会话，显示后自动消失）
  compactNotices: Record<string, CompactNotice>
  /** 手动压缩进行中（显式用户操作，全局一次一个即可） */
  isCompacting: boolean

  // 单轮输出被 max_tokens 截断的通知（按会话，显示后自动消失）
  truncatedNotices: Record<string, TruncatedNotice>

  // 设置 — 草稿模式（改动不点"保存"不生效；"取消"丢弃改动恢复原值）
  settings: AppSettings                       // 权威设置（来自 DB），设置页之外的 UI 用这个
  settingsDraft: SettingsDraft                // 设置页草稿（各设置子组件读写这个，未保存）
  isSettingsDirty: boolean                    // 草稿是否有未保存的改动（含主题/字号）
  /** 外观基线快照（取消时恢复到这里；保存成功后前移到已保存值） */
  settingsSnapshot: { theme: Theme; fontSize: number } | null
  loadSettings: () => Promise<void>
  /** 进入设置页：初始化草稿 = 权威设置 + 当前外观，记录快照 */
  openSettings: () => void
  /** 修改草稿（不写库） */
  updateSettingsDraft: (patch: Partial<SettingsDraft>) => void
  /** 保存：把草稿写入 DB 并提升为权威设置 */
  saveSettings: () => Promise<void>
  /** 取消：丢弃草稿，恢复外观快照 */
  cancelSettings: () => void

  // Agent 操作
  sendMessage: (text: string, images?: string[]) => Promise<void>
  /** 中止当前活跃会话的运行 */
  abortAgent: () => void
  /** 手动压缩当前会话上下文（运行中不可用） */
  compactNow: () => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  // ---- 视图 ----
  view: 'chat',
  setView: (v) => set({ view: v }),

  // ---- 布局 ----
  sidebarWidth: getStoredSidebarWidth(),
  setSidebarWidth: (px) => {
    const w = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(px)))
    set({ sidebarWidth: w })
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)) } catch { /* ignore */ }
  },
  sidebarCollapsed: getStoredSidebarCollapsed(),
  setSidebarCollapsed: (v) => {
    set({ sidebarCollapsed: v })
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0') } catch { /* ignore */ }
  },
  inputAreaHeight: getStoredInputHeight(),
  setInputAreaHeight: (px) => {
    // px>0 时钳制在 [INPUT_MIN_HEIGHT, INPUT_MAX_HEIGHT]；0 = 自适应
    const h = px > 0 ? Math.min(INPUT_MAX_HEIGHT, Math.max(INPUT_MIN_HEIGHT, Math.round(px))) : 0
    set({ inputAreaHeight: h })
    try { localStorage.setItem(INPUT_HEIGHT_KEY, String(h)) } catch { /* ignore */ }
  },

  // ---- 主题 / 字号 ----
  theme: getStoredTheme(),
  setTheme: (t) => set({ theme: t }),
  fontSize: getStoredFontSize(),
  setFontSize: (n) => set({ fontSize: n }),

  // ---- 会话 ----
  sessions: [],
  activeSessionId: null,
  setActiveSession: (id) => {
    // 选择会话 = 回到聊天视图（修复停留在设置页时点会话不切换的问题）
    // 设置页草稿与"取消"按钮同语义：离开即丢弃，避免脏状态残留影响下次进入
    get().cancelSettings()
    set({ activeSessionId: id, view: 'chat' })
    // 缓存未命中才拉取（后台会话的消息由事件流持续累积，切回无需重拉）
    if (id && get().messages[id] === undefined) {
      void get().loadMessages(id)
    }
    // 压缩标记未加载过才拉取（用于渲染"历史已折叠"标记）
    if (id && get().compactionMarkers[id] === undefined) {
      void get().loadCompaction(id)
    }
  },
  loadSessions: async () => {
    const sessions = await api.session.list()
    set({ sessions })
  },
  createSession: async () => {
    get().cancelSettings()
    const session = await api.session.create()
    set((s) => ({
      sessions: [session, ...s.sessions],
      activeSessionId: session.id,
      view: 'chat',
      messages: { ...s.messages, [session.id]: [] }
    }))
  },
  deleteSession: async (id) => {
    // 会话运行中 → 先停止（避免孤儿运行继续写库）
    if (get().runningIds.has(id)) {
      api.agent.abort(id)
      get().markRunning(id, false)
      get().setRetryStatus(id, null)
      set((s) => {
        const reqs = { ...s.permissionRequests }
        delete reqs[id]
        return { permissionRequests: reqs }
      })
    }
    await api.session.delete(id)
    const { sessions, activeSessionId } = get()
    const newSessions = sessions.filter(s => s.id !== id)
    const newActiveId = activeSessionId === id
      ? (newSessions[0]?.id || null)
      : activeSessionId
    set((s) => {
      const messages = { ...s.messages }
      delete messages[id]
      const compactionMarkers = { ...s.compactionMarkers }
      delete compactionMarkers[id]
      return { sessions: newSessions, activeSessionId: newActiveId, messages, compactionMarkers }
    })
    if (newActiveId) void get().loadMessages(newActiveId)
  },

  // ---- 删除会话确认（弹窗流程）----
  pendingDeleteId: null,
  requestDeleteSession: (id) => set({ pendingDeleteId: id }),
  cancelDeleteSession: () => set({ pendingDeleteId: null }),
  confirmDeleteSession: async () => {
    const id = get().pendingDeleteId
    if (!id) return
    set({ pendingDeleteId: null })
    await get().deleteSession(id)
  },

  // ---- 消息（按会话缓存） ----
  messages: {},
  compactionMarkers: {},
  loadMessages: (sessionId) => {
    const inflight = loadingMessages.get(sessionId)
    if (inflight) return inflight
    const p = (async () => {
      try {
        const msgs = await api.session.messages(sessionId)
        set((s) => ({ messages: { ...s.messages, [sessionId]: msgs } }))
      } finally {
        loadingMessages.delete(sessionId)
      }
    })()
    loadingMessages.set(sessionId, p)
    return p
  },
  loadCompaction: async (sessionId) => {
    try {
      const c = await api.session.compaction(sessionId)
      set((s) => ({ compactionMarkers: { ...s.compactionMarkers, [sessionId]: c } }))
    } catch {
      // 忽略：无压缩或 IPC 异常时保持无标记
    }
  },

  // ---- Agent 运行状态（按会话，支持并行） ----
  runningIds: new Set<string>(),
  markRunning: (sessionId, running) => {
    set((s) => {
      const runningIds = new Set(s.runningIds)
      if (running) runningIds.add(sessionId)
      else runningIds.delete(sessionId)
      return { runningIds }
    })
  },
  retryStatus: {},
  setRetryStatus: (sessionId, status) => {
    set((s) => {
      const retryStatus = { ...s.retryStatus }
      if (status) retryStatus[sessionId] = status
      else delete retryStatus[sessionId]
      return { retryStatus }
    })
  },

  // ---- 模型选择 ----
  selectedProviderModel: null,
  setSelectedProviderModel: (v) => set({ selectedProviderModel: v }),

  // ---- 批准模式（三档）----
  approveMode: getStoredApproveMode(),
  setApproveMode: (v) => {
    set({ approveMode: v })
    try { localStorage.setItem('zhumora.approveMode', v) } catch { /* ignore */ }
    // 同步到 main 进程（该会话若正在运行中，即时生效）
    const { activeSessionId } = get()
    if (activeSessionId) {
      api.agent.setApproveMode(activeSessionId, v)
    }
  },

  // ---- 对话级思考强度 ----
  reasoningEffort: getStoredReasoningEffort(),
  setReasoningEffort: (v) => {
    set({ reasoningEffort: v })
    try { localStorage.setItem('zhumora.reasoningEffort', v) } catch { /* ignore */ }
  },

  sendMessage: async (text: string, images?: string[]) => {
    let { activeSessionId } = get()
    if (!activeSessionId) {
      await get().createSession()
      activeSessionId = get().activeSessionId!
    }
    const sid = activeSessionId
    if (!sid) return
    // 该会话正在运行 → 不允许重入（其他会话不受影响，可并行）
    if (get().runningIds.has(sid)) return

    // 添加用户消息 + 思考占位消息（发送后立即显示"思考中 + 转圈动画"）
    const userMsg: UIMessage = {
      id: `local-${Date.now()}`,
      sessionId: sid,
      role: 'user',
      content: text,
      images: images && images.length > 0 ? images : undefined,
      timestamp: Date.now(),
      status: 'done'
    }
    const thinkingMsg: UIMessage = {
      id: `thinking-${sid}-${Date.now()}`,
      sessionId: sid,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'thinking'
    }
    set((s) => ({
      messages: { ...s.messages, [sid]: [...(s.messages[sid] || []), userMsg, thinkingMsg] }
    }))

    try {
      // 解析 selectedProviderModel — 格式 "providerId::modelName"
      const spm = get().selectedProviderModel
      let providerId: string | undefined
      let modelOverride: string | undefined
      if (spm) {
        const sepIdx = spm.indexOf('::')
        if (sepIdx > 0) {
          providerId = spm.slice(0, sepIdx)
          modelOverride = spm.slice(sepIdx + 2) || undefined
        }
      }
      // 思考强度：仅当所选 provider 开启了该功能才生效（否则 UI 不显示下拉，也不发送参数）
      const settings = get().settings
      const runProvider = settings.providers.find(p => p.id === providerId)
        || (settings.activeProviderId ? settings.providers.find(p => p.id === settings.activeProviderId) : undefined)
      const effort = runProvider?.reasoningEnabled ? get().reasoningEffort : 'off'

      const result = await api.agent.run(sid, { text, images }, {
        providerId,
        modelOverride,
        approveMode: get().approveMode,
        reasoningEffort: effort
      })
      if (result.error) {
        // 启动失败（如未配置 provider）：移除思考占位，追加错误消息
        set((s) => {
          const msgs = (s.messages[sid] || []).filter(m => m.status !== 'thinking')
          return {
            messages: {
              ...s.messages,
              [sid]: [...msgs, {
                id: `err-${Date.now()}`,
                sessionId: sid,
                role: 'assistant' as const,
                content: `Error: ${result.error}`,
                timestamp: Date.now(),
                status: 'error' as const
              }]
            }
          }
        })
        return
      }
      // 运行状态由 main 进程的 agent:running 事件权威驱动（事件先于 invoke 响应到达，
      // 无需在这里乐观标记 —— 避免"运行已快速失败但 UI 仍显示 running"的竞态）
    } catch (err) {
      set((s) => {
        const msgs = (s.messages[sid] || []).filter(m => m.status !== 'thinking')
        return {
          messages: {
            ...s.messages,
            [sid]: [...msgs, {
              id: `err-${Date.now()}`,
              sessionId: sid,
              role: 'assistant' as const,
              content: `Error: ${(err as Error).message}`,
              timestamp: Date.now(),
              status: 'error' as const
            }]
          }
        }
      })
    }
  },

  abortAgent: () => {
    const { activeSessionId } = get()
    if (activeSessionId) {
      api.agent.abort(activeSessionId)
      get().markRunning(activeSessionId, false)
      get().setRetryStatus(activeSessionId, null)
    }
  },

  // ---- 权限（按会话 FIFO 处理） ----
  permissionRequests: {},
  respondPermission: (allowed: boolean) => {
    // 多个并行会话可能同时有弹窗 → 按 permId 生成顺序（FIFO）处理最早的
    const reqs = Object.values(get().permissionRequests)
      .sort((a, b) => a.permId.localeCompare(b.permId))
    const req = reqs[0]
    if (req) {
      api.agent.respondPermission(req.permId, allowed)
      set((s) => {
        const rest = { ...s.permissionRequests }
        delete rest[req.sessionId]
        return { permissionRequests: rest }
      })
    }
  },

  // ---- 上下文压缩通知 ----
  compactNotices: {},
  isCompacting: false,

  // ---- 输出截断通知（agent:truncated 事件驱动，App.tsx 负责 8s 后清除）----
  truncatedNotices: {},

  compactNow: async () => {
    const { activeSessionId, runningIds, isCompacting } = get()
    if (!activeSessionId || runningIds.has(activeSessionId) || isCompacting) return
    const sid = activeSessionId
    set({ isCompacting: true })
    try {
      const res = await api.agent.compactNow(sid)
      if (res.error) {
        console.error('Manual compact error:', res.error)
        // 失败提示：复用压缩通知条（红色错误态），几秒后自动消失
        set((s) => ({ compactNotices: { ...s.compactNotices, [sid]: { beforeTokens: 0, afterTokens: 0, compressedCount: 0, keptCount: 0, error: res.error } } }))
        setTimeout(() => {
          set((s) => {
            const rest = { ...s.compactNotices }
            delete rest[sid]
            return { compactNotices: rest }
          })
        }, 6000)
        return
      }
      // 主进程压缩成功后会广播 agent:compact → App.tsx 设置 compactNotice +
      // 更新 compactionMarkers（消息表不变，无需重拉消息）
      await get().loadCompaction(sid)
    } finally {
      set({ isCompacting: false })
    }
  },

  // ---- 设置（草稿模式）----
  settings: {
    providers: [],
    mcpServers: [],
    skills: [],
    activeProviderId: null,
    workspacePath: ''
  },
  settingsDraft: {
    providers: [],
    mcpServers: [],
    skills: [],
    activeProviderId: null,
    workspacePath: '',
    theme: 'system',
    fontSize: DEFAULT_FONT_SIZE
  },
  isSettingsDirty: false,
  settingsSnapshot: null,
  loadSettings: async () => {
    const settings = await api.settings.get()
    set({ settings })
  },
  openSettings: () => {
    const { settings, theme, fontSize } = get()
    set({
      // 草稿从权威设置 + 当前外观初始化（浅拷贝足够：子组件每次提交整个数组）
      settingsDraft: { ...settings, theme, fontSize },
      isSettingsDirty: false,
      settingsSnapshot: { theme, fontSize }
    })
  },
  updateSettingsDraft: (patch) => {
    set((s) => ({
      settingsDraft: { ...s.settingsDraft, ...patch },
      isSettingsDirty: true
    }))
  },
  saveSettings: async () => {
    const { settingsDraft: draft } = get()
    try {
      // 落库的是 AppSettings（theme/fontSize 不在 DB schema 里，
      // 它们是 localStorage 项，setTheme/setFontSize 时已实时持久化）
      const { theme: _theme, fontSize: _fontSize, ...dbSettings } = draft
      await api.settings.save(dbSettings)
      // 草稿提升为权威设置；快照前移到已保存值
      // （之后取消只回滚"本次保存之后"的改动，不会把刚保存的主题/字号退回旧值）
      set({
        settings: dbSettings,
        settingsDraft: { ...draft },
        isSettingsDirty: false,
        settingsSnapshot: { theme: draft.theme, fontSize: draft.fontSize }
      })
    } catch (err) {
      console.error('Failed to save settings:', err)
    }
  },
  cancelSettings: () => {
    const { settings, settingsSnapshot, theme, fontSize } = get()
    // 外观回退到基线快照（编辑时是即时预览的）
    const base = settingsSnapshot || { theme, fontSize }
    set({
      settingsDraft: { ...settings, theme: base.theme, fontSize: base.fontSize },
      isSettingsDirty: false,
      theme: base.theme,
      fontSize: base.fontSize
    })
    try { localStorage.setItem(THEME_STORAGE_KEY, base.theme) } catch { /* ignore */ }
    try { localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(base.fontSize)) } catch { /* ignore */ }
    // 恢复界面语言（编辑时是即时切换的预览）
    const effective = getEffectiveLanguage((settings.language as AppLanguage) || 'auto')
    storeLanguage((settings.language as AppLanguage) || 'auto')
    i18n.changeLanguage(effective)
  }
}))
