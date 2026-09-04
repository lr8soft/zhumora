import { useEffect } from 'react'
import { useAppStore, THEME_STORAGE_KEY, FONT_SIZE_STORAGE_KEY } from './store'
import i18n, { getEffectiveLanguage, storeLanguage, type AppLanguage } from './i18n'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import SettingsView from './components/SettingsView'
import PermissionDialog from './components/PermissionDialog'
import ConfirmDeleteDialog from './components/ConfirmDeleteDialog'
import {
  applyAssistantStart,
  applyAssistantEnd,
  applyPersistedMessage,
  applyToolCallEvent,
  applyToolResultEvent,
  applyTokenDeltas,
  type TokenDelta
} from './agentEvents'

// ============================================================
// 流式 token 批量缓冲（长会话卡顿的核心修复）
//
// 问题：LLM 流式输出可达 50-100 token/s，旧实现每个 token 都
// setState 一次 → 每次触发 ChatView 全树 reconcile + 流式消息的
// 整段 Markdown 重解析。成本 = 每 token × O(会话总长度)，
// 会话越长单 token 越贵，宏观上表现为"工作时间越长越卡"。
//
// 修复：token/reasoning 事件只写入内存缓冲（不碰 store），
// 固定 32ms 节拍批量 flush 一次 → setState 频率从每 token 降到
// ≤31 次/秒；结构事件（tool_call / assistant phase / complete）
// 先强制 flush 再处理，保证顺序语义与旧实现一致。
//
// 消息归并逻辑本身在 agentEvents.ts（纯 reducer，node 可测）。
// ============================================================

/** 缓冲键：sessionId\0messageId */
let pendingTokens = new Map<string, TokenDelta>()
let flushTimer: ReturnType<typeof setInterval> | null = null
/** 待 flush 的会话集合（避免 flush 时遍历全量缓冲键） */
const pendingSessions = new Set<string>()

const TOKEN_FLUSH_MS = 32

function keyOf(sessionId: string, msgId: string): string {
  return `${sessionId}\0${msgId}`
}

/**
 * 缓冲一个流式增量。IPC 保证 assistant:start 先于 token，renderer
 * 只按 main 分配的 id 路由，不猜测"最后一条消息"。
 */
function bufferToken(sessionId: string, targetId: string, kind: 'content' | 'reasoning', text: string) {
  const k = keyOf(sessionId, targetId)
  let p = pendingTokens.get(k)
  if (!p) {
    p = { msgId: targetId, content: '', reasoning: '' }
    pendingTokens.set(k, p)
  }
  if (kind === 'content') p.content += text
  else p.reasoning += text
  pendingSessions.add(sessionId)
  ensureFlushTimer()
}

function ensureFlushTimer() {
  if (flushTimer !== null) return
  flushTimer = setInterval(flushPending, TOKEN_FLUSH_MS)
}

/** 把缓冲里的增量一次性写进 store。无增量时 no-op。 */
function flushPending() {
  if (pendingTokens.size === 0) return
  const toFlush = pendingTokens
  const sessions = [...pendingSessions]
  pendingTokens = new Map()
  pendingSessions.clear()
  if (flushTimer !== null) {
    clearInterval(flushTimer)
    flushTimer = null
  }

  // 按会话分组（缓冲条目本身不带 sessionId —— 从 key 解析）
  const grouped = new Map<string, TokenDelta[]>()
  for (const [k, p] of toFlush) {
    const sid = k.slice(0, k.indexOf('\0'))
    let g = grouped.get(sid)
    if (!g) { g = []; grouped.set(sid, g) }
    g.push(p)
  }

  useAppStore.setState((s) => {
    let messages = s.messages
    for (const sid of sessions) {
      const msgs = messages[sid]
      if (msgs === undefined) continue
      const deltas = grouped.get(sid)
      if (!deltas) continue
      const next = applyTokenDeltas(msgs, deltas)
      if (next !== msgs) messages = { ...messages, [sid]: next }
    }
    return { messages }
  })
}

export default function App() {
  // 注意：必须用 selector 订阅（无选择器 useAppStore() 会订阅全 store，
  // 每个流式 token 都触发 App 整树重渲染 → 长会话卡顿的根因之一）
  const view = useAppStore(s => s.view)
  const theme = useAppStore(s => s.theme)
  const fontSize = useAppStore(s => s.fontSize)
  const sidebarWidth = useAppStore(s => s.sidebarWidth)
  const sidebarCollapsed = useAppStore(s => s.sidebarCollapsed)

  // 初始化
  useEffect(() => {
    const st = useAppStore.getState()
    st.loadSessions().then(() => {
      const { sessions } = useAppStore.getState()
      if (sessions.length > 0) {
        useAppStore.getState().setActiveSession(sessions[0].id)
      }
    })
    // 加载设置后同步语言（DB 为权威来源）
    st.loadSettings().then(() => {
      const { settings } = useAppStore.getState()
      if (settings.language) {
        const lang = settings.language as AppLanguage
        const effective = getEffectiveLanguage(lang)
        storeLanguage(lang)
        i18n.changeLanguage(effective)
      }
    })
    // 恢复运行状态（渲染进程重启 / 刷新后，main 进程里仍在跑的会话继续显示转圈）
    window.api.agent.running().then(ids => {
      for (const id of ids) useAppStore.getState().markRunning(id, true)
    })
  }, [])

  // 主题：light / dark / system（system 实时跟随系统深浅色）
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    applyTheme()
    media.addEventListener('change', applyTheme)
    try { localStorage.setItem(THEME_STORAGE_KEY, theme) } catch { /* ignore */ }
    return () => media.removeEventListener('change', applyTheme)
  }, [theme])

  // 字号：设置根字号，全局 rem 等比缩放
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`
    try { localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize)) } catch { /* ignore */ }
  }, [fontSize])

  // 注册 IPC 事件
  // 核心原则：所有 agent 事件都携带 sessionId 并按会话路由 ——
  // 事件落在对应会话的消息缓存里（后台会话照常累积），
  // 只有"当前显示会话"的状态变化才会引起界面刷新，从而会话之间互不串台。
  // 归并规则全部在 agentEvents.ts（按 main 权威 ID 定位，可单测）。
  useEffect(() => {
    /** 向某会话的消息缓存应用一个 reducer（该会话缓存不存在时忽略） */
    const pushMessage = (sessionId: string, fn: (msgs: import('@shared/types').UIMessage[]) => import('@shared/types').UIMessage[]) => {
      useAppStore.setState((s) => {
        const msgs = s.messages[sessionId]
        if (msgs === undefined) return s
        return { messages: { ...s.messages, [sessionId]: fn(msgs) } }
      })
    }
    /** 清除某会话的权限请求与重试状态（complete/error/abort 收尾共用） */
    const clearSessionOverlays = (sessionId: string) => {
      const st = useAppStore.getState()
      st.markRunning(sessionId, false)
      st.setRetryStatus(sessionId, null)
      const reqs = { ...st.permissionRequests }
      delete reqs[sessionId]
      useAppStore.setState({ permissionRequests: reqs })
    }

    // 结构事件处理器开头强制 flush：保证"token 先于结构事件落库"的
    // 顺序语义（与旧实现一致，防止 phase=start 替换消息时丢失未 flush 的 token）
    const unsubs = [
      // 外部 Bot 输入已由 main 落库；缓存存在时立即追加，未打开过的会话按需从 DB 加载。
      window.api.agent.onUserMessage(({ sessionId, message }) => {
        flushPending()
        pushMessage(sessionId, current => applyPersistedMessage(message, current))
      }),

      // 流式思考内容 → 写缓冲（不直接 setState；32ms 节拍批量落 store）
      window.api.agent.onReasoning(({ sessionId, messageId, token }) => {
        const msgs = useAppStore.getState().messages[sessionId]
        if (msgs === undefined) return
        bufferToken(sessionId, messageId, 'reasoning', token)
      }),

      // 流式 token → 写缓冲（精确路由到 messageId 对应的消息）
      window.api.agent.onToken(({ sessionId, messageId, token }) => {
        const msgs = useAppStore.getState().messages[sessionId]
        if (msgs === undefined) return
        bufferToken(sessionId, messageId, 'content', token)
      }),

      // assistant 消息事件（phase=start：本轮开始，替换 thinking 占位为流式消息；
      // phase=end：本轮结束，把流式消息收尾为 done）。
      window.api.agent.onAssistantMessage(({ sessionId, messageId, content, toolCalls, phase, reasoning }) => {
        flushPending()
        const now = Date.now()
        if (phase === 'start') {
          pushMessage(sessionId, (m) => applyAssistantStart(sessionId, messageId, m, now))
          return
        }
        pushMessage(sessionId, (m) => applyAssistantEnd(sessionId, messageId, content, toolCalls, reasoning, m, now))
      }),

      // 工具调用 → 挂到对应 assistant 消息（不再依赖 activeSessionId，后台会话同样累积）
      window.api.agent.onToolCall(({ sessionId, messageId, toolCall }) => {
        flushPending()
        if (!messageId) return
        const now = Date.now()
        pushMessage(sessionId, (m) => applyToolCallEvent(sessionId, messageId, toolCall, m, now))
      }),

      // 工具结果 → 以 main 持久化 id 追加
      window.api.agent.onToolResult(({ sessionId, messageId, toolCallId, toolName, result, isError }) => {
        flushPending()
        const now = Date.now()
        pushMessage(sessionId, (m) => applyToolResultEvent(sessionId, messageId, toolCallId, toolName, result, isError, m, now))
      }),

      // 对话完成 → 强制从 DB 校准；后台会话也刷新，避免缓存命中后长期停留在旧历史。
      window.api.agent.onComplete(({ sessionId }) => {
        flushPending()
        const st = useAppStore.getState()
        clearSessionOverlays(sessionId)
        void st.loadMessages(sessionId, true)
        void st.loadSessions()
      }),

      // 错误 → 该会话退出运行态；错误消息已由 main 存入 DB
      window.api.agent.onError(({ sessionId }) => {
        flushPending()
        const st = useAppStore.getState()
        clearSessionOverlays(sessionId)
        void st.loadMessages(sessionId, true)
        void st.loadSessions()
      }),

      // 用户中止 → 该会话退出运行态
      window.api.agent.onAborted(({ sessionId }) => {
        flushPending()
        const st = useAppStore.getState()
        st.markRunning(sessionId, false)
        st.setRetryStatus(sessionId, null)
        // 移除可能残留的思考占位，并强制刷新 DB 记录。
        pushMessage(sessionId, (m) => m.filter(x => x.status !== 'thinking'))
        void st.loadMessages(sessionId, true)
        void st.loadSessions()
      }),

      // 运行状态变化（main 进程权威：开始/结束运行）
      window.api.agent.onRunningChange(({ sessionId, running }) => {
        const st = useAppStore.getState()
        st.markRunning(sessionId, running)
        if (running) void st.loadSessions()
      }),

      // 网络重试状态（按会话）
      window.api.agent.onRetry(({ sessionId, failedAttempt, maxRetries }) => {
        useAppStore.getState().setRetryStatus(sessionId, { failedAttempt, maxRetries })
      }),

      // 单轮输出被 max_tokens 截断（按会话）→ 展示提示条，8 秒后自动消失
      window.api.agent.onTruncated(({ sessionId, kind }) => {
        useAppStore.setState((s) => ({
          truncatedNotices: { ...s.truncatedNotices, [sessionId]: { kind } }
        }))
        setTimeout(() => {
          useAppStore.setState((s) => {
            const rest = { ...s.truncatedNotices }
            delete rest[sessionId]
            return { truncatedNotices: rest }
          })
        }, 8000)
      }),

      // 权限请求（按会话存入；UI 按 FIFO 显示，不影响其他并行会话）
      window.api.agent.onPermissionRequest(({ sessionId, permId, toolName, args, level }) => {
        useAppStore.setState((s) => ({
          permissionRequests: { ...s.permissionRequests, [sessionId]: { permId, sessionId, toolName, args, level } }
        }))
      }),

      // Telegram 或客户端任一端先完成确认后，另一端同步关闭同一权限请求。
      window.api.agent.onPermissionResolved(({ sessionId, permId }) => {
        useAppStore.setState((s) => {
          if (s.permissionRequests[sessionId]?.permId !== permId) return s
          const rest = { ...s.permissionRequests }
          delete rest[sessionId]
          return { permissionRequests: rest }
        })
      }),

      // 上下文压缩通知（按会话；仅当当前显示该会话时展示提示）
      // 压缩不删除消息 → 消息表不变，无需刷新消息缓存；
      // 只需更新"历史已折叠"标记位置（boundaryMessageId）供 UI 渲染。
      window.api.agent.onCompact(({ sessionId, source, boundaryMessageId, beforeTokens, afterTokens, compressedCount, keptCount }) => {
        const st = useAppStore.getState()
        // 更新压缩标记（auto / manual 都会持久化压缩状态）
        if (boundaryMessageId) {
          useAppStore.setState((s) => ({
            compactionMarkers: { ...s.compactionMarkers, [sessionId]: { upToMessageId: boundaryMessageId } }
          }))
        }
        if (st.activeSessionId === sessionId) {
          useAppStore.setState((s) => ({
            compactNotices: {
              ...s.compactNotices,
              [sessionId]: { beforeTokens, afterTokens, compressedCount, keptCount }
            }
          }))
          setTimeout(() => {
            useAppStore.setState((s) => {
              const rest = { ...s.compactNotices }
              delete rest[sessionId]
              return { compactNotices: rest }
            })
          }, 8000)
        }
        if (source === 'manual') {
          void st.loadSessions()
        }
      }),

      // 静默消费日志
      window.api.onLog(() => {}),

      // 会话标题更新（LLM 自动命名）
      window.api.onSessionTitleUpdated(({ sessionId, title }) => {
        useAppStore.setState((s) => ({
          sessions: s.sessions.map(x =>
            x.id === sessionId ? { ...x, title } : x
          )
        }))
      }),

      // 设置被主进程侧修改（如 agent 通过 mcp_* 工具增删 MCP 服务器）→ 刷新设置页
      window.api.settings.onChanged(() => {
        useAppStore.getState().loadSettings().then(() => {
          const cur = useAppStore.getState()
          // 设置页正在编辑且有未保存修改 → 不动草稿（避免覆盖用户正在输入的内容）；
          // 否则同步草稿，让设置页实时反映 agent 的变更（theme/fontSize 是 localStorage 项，保留当前值）
          if (cur.view === 'settings' && !cur.isSettingsDirty) {
            useAppStore.setState({
              settingsDraft: { ...cur.settings, theme: cur.settingsDraft.theme, fontSize: cur.settingsDraft.fontSize }
            })
          }
        })
      })
    ]

    return () => {
      unsubs.forEach(fn => fn())
      // 卸载（HMR / 刷新）时落掉缓冲里残留的增量，并停掉节拍器
      if (flushTimer !== null) {
        clearInterval(flushTimer)
        flushTimer = null
      }
      flushPending()
    }
  }, [])

  return (
    <div className="app-frame">
      {/* 自定义窗口标题栏 */}
      <TitleBar />

      <div
        className={sidebarCollapsed ? 'app-shell sidebar-is-collapsed' : 'app-shell'}
        style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` }}
      >
        {/* 侧边栏 */}
        <Sidebar />

        {/* 主内容区 */}
        <main className="main-area">
          {view === 'chat' ? <ChatView /> : <SettingsView />}
        </main>
      </div>

      {/* 权限确认弹窗（多会话并行时按 FIFO 逐个确认） */}
      <PermissionDialog />

      {/* 会话删除确认弹窗（防误操作；z-index 高于权限弹窗，用户主动删除时置于最前） */}
      <ConfirmDeleteDialog />
    </div>
  )
}
