import { useEffect } from 'react'
import { useAppStore, THEME_STORAGE_KEY, FONT_SIZE_STORAGE_KEY } from './store'
import i18n, { getEffectiveLanguage, storeLanguage, type AppLanguage } from './i18n'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import SettingsView from './components/SettingsView'
import PermissionDialog from './components/PermissionDialog'
import ConfirmDeleteDialog from './components/ConfirmDeleteDialog'

/** 向某会话的消息缓存追加/更新消息（该会话缓存不存在时自动初始化） */
function pushMessage(sessionId: string, fn: (msgs: import('@shared/types').UIMessage[]) => import('@shared/types').UIMessage[]) {
  useAppStore.setState((s) => {
    const msgs = s.messages[sessionId]
    if (msgs === undefined) return s
    return { messages: { ...s.messages, [sessionId]: fn(msgs) } }
  })
}

export default function App() {
  const { view, loadSessions, loadSettings, setActiveSession, theme, fontSize } = useAppStore()

  // 初始化
  useEffect(() => {
    loadSessions().then(() => {
      const { sessions } = useAppStore.getState()
      if (sessions.length > 0) {
        setActiveSession(sessions[0].id)
      }
    })
    // 加载设置后同步语言（DB 为权威来源）
    loadSettings().then(() => {
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
  useEffect(() => {
    const unsubs = [
      // 流式 token → 精确路由到 messageId 对应的消息（占位消息收到首 token 即转为流式）
      window.api.agent.onToken(({ sessionId, messageId, token }) => {
        const msgs = useAppStore.getState().messages[sessionId]
        if (msgs === undefined) return
        const idx = msgs.findIndex(m => m.id === messageId)
        if (idx >= 0) {
          pushMessage(sessionId, (m) => m.map((x, i) =>
            i === idx ? { ...x, content: x.content + token, status: 'streaming' as const } : x
          ))
          return
        }
        // 兜底：assistant 消息事件丢失时，append 到最后一条可流式的 assistant 消息
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant' && (last.status === 'thinking' || last.status === 'streaming')) {
          pushMessage(sessionId, (m) => {
            const next = [...m]
            next[next.length - 1] = { ...last, content: last.content + token, status: 'streaming' as const }
            return next
          })
          return
        }
        // 再兜底：新建一条流式消息
        pushMessage(sessionId, (m) => [...m, {
          id: messageId || `stream-${Date.now()}`,
          sessionId,
          role: 'assistant' as const,
          content: token,
          timestamp: Date.now(),
          status: 'streaming' as const
        }])
      }),

      // assistant 消息事件（phase=start：本轮开始，替换 thinking 占位为流式消息；
      // phase=end：本轮结束，把流式消息收尾为 done）。
      // 工具行不在此渲染（onToolCall 事件负责，避免重复）；
      // 纯工具调用且无文本的轮次不创建空气泡。
      window.api.agent.onAssistantMessage(({ sessionId, messageId, content, phase }) => {
        const msgs = useAppStore.getState().messages[sessionId]
        if (msgs === undefined) return
        pushMessage(sessionId, (m) => {
          if (phase === 'start') {
            // 把 thinking 占位替换为正式流式消息（无占位时直接追加）
            const idx = m.findIndex(x => x.status === 'thinking')
            if (idx >= 0) {
              const next = [...m]
              next[idx] = {
                id: messageId,
                sessionId,
                role: 'assistant' as const,
                content: '',
                timestamp: Date.now(),
                status: 'streaming' as const
              }
              return next
            }
            if (m.some(x => x.id === messageId)) return m
            return [...m, {
              id: messageId,
              sessionId,
              role: 'assistant' as const,
              content: '',
              timestamp: Date.now(),
              status: 'streaming' as const
            }]
          }
          // phase === 'end'
          const existingIdx = m.findIndex(x => x.id === messageId)
          if (existingIdx >= 0) {
            const finalContent = content || m[existingIdx].content
            // 纯工具轮（无任何文本）：start 时创建的空流式气泡直接移除，
            // 工具行由 onToolCall 事件渲染，避免留下空气泡
            if (!finalContent) return m.filter((_, i) => i !== existingIdx)
            // 流式消息收尾
            const updated = [...m]
            updated[existingIdx] = {
              ...updated[existingIdx],
              content: finalContent,
              status: 'done' as const
            }
            return updated
          }
          if (!content) return m
          return [...m, {
            id: messageId,
            sessionId,
            role: 'assistant' as const,
            content,
            timestamp: Date.now(),
            status: 'done' as const
          }]
        })
      }),

      // 工具调用 → 插入到对应会话（不再依赖 activeSessionId，后台会话同样累积）
      window.api.agent.onToolCall(({ sessionId, toolCall }) => {
        pushMessage(sessionId, (m) => {
          const next = m.filter(x => x.status !== 'thinking')
          next.push({
            id: `tc-${toolCall.id || Date.now()}`,
            sessionId,
            role: 'assistant' as const,
            content: '',
            toolCalls: [toolCall],
            timestamp: Date.now(),
            status: 'pending' as const
          })
          return next
        })
      }),

      // 工具结果 → 插入到对应会话
      window.api.agent.onToolResult(({ sessionId, toolCallId, toolName, result, isError }) => {
        pushMessage(sessionId, (m) => [...m, {
          id: `tr-${toolCallId}-${Date.now()}`,
          sessionId,
          role: 'tool' as const,
          content: result,
          toolCallId,
          toolName,
          timestamp: Date.now(),
          status: isError ? ('error' as const) : ('done' as const)
        }])
      }),

      // 对话完成 → 该会话退出运行态；若正显示该会话则刷新完整数据库记录
      window.api.agent.onComplete(({ sessionId }) => {
        const st = useAppStore.getState()
        st.markRunning(sessionId, false)
        st.setRetryStatus(sessionId, null)
        const reqs = { ...st.permissionRequests }
        delete reqs[sessionId]
        useAppStore.setState({ permissionRequests: reqs })
        if (st.activeSessionId === sessionId) {
          void st.loadMessages(sessionId)
        }
        void st.loadSessions()
      }),

      // 错误 → 该会话退出运行态；错误消息已由 main 存入 DB
      window.api.agent.onError(({ sessionId }) => {
        const st = useAppStore.getState()
        st.markRunning(sessionId, false)
        st.setRetryStatus(sessionId, null)
        const reqs = { ...st.permissionRequests }
        delete reqs[sessionId]
        useAppStore.setState({ permissionRequests: reqs })
        if (st.activeSessionId === sessionId) {
          void st.loadMessages(sessionId)
        }
        void st.loadSessions()
      }),

      // 用户中止 → 该会话退出运行态
      window.api.agent.onAborted(({ sessionId }) => {
        const st = useAppStore.getState()
        st.markRunning(sessionId, false)
        st.setRetryStatus(sessionId, null)
        if (st.activeSessionId === sessionId) {
          // 移除可能残留的思考占位，刷新 DB 记录
          pushMessage(sessionId, (m) => m.filter(x => x.status !== 'thinking'))
          void st.loadMessages(sessionId)
        }
        void st.loadSessions()
      }),

      // 运行状态变化（main 进程权威：开始/结束运行）
      window.api.agent.onRunningChange(({ sessionId, running }) => {
        useAppStore.getState().markRunning(sessionId, running)
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

    return () => unsubs.forEach(fn => fn())
  }, [])

  return (
    <div className="app-frame">
      {/* 自定义窗口标题栏 */}
      <TitleBar />

      <div className="app-shell">
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
