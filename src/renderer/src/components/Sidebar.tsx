import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Settings2, Trash2 } from 'lucide-react'
import { useAppStore } from '../store'

export default function Sidebar() {
  const { t } = useTranslation()
  const sessions = useAppStore(s => s.sessions)
  const activeSessionId = useAppStore(s => s.activeSessionId)
  // 运行中的会话集合（多个会话可并行运行，各自独立转圈）
  const runningIds = useAppStore(s => s.runningIds)
  const view = useAppStore(s => s.view)
  const collapsed = useAppStore(s => s.sidebarCollapsed)
  const setSidebarCollapsed = useAppStore(s => s.setSidebarCollapsed)
  // actions 引用稳定，从 getState 取（避免整 store 订阅导致流式期间高频重渲染）
  const { setActiveSession, createSession, requestDeleteSession, setView } = useAppStore.getState()

  /** 拖拽调整侧边栏宽度：document 级监听，松手即清理（宽度 clamp + 持久化在 store 内） */
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = useAppStore.getState().sidebarWidth
    const onMove = (ev: MouseEvent) => {
      useAppStore.getState().setSidebarWidth(startWidth + (ev.clientX - startX))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // 设置入口点击（展开/收起态共用：有未保存改动时离开需确认）
  const onSettingsClick = () => {
    if (view === 'settings') {
      const st = useAppStore.getState()
      if (st.isSettingsDirty && !confirm(t('settings.confirmLeave'))) return
      // 离开设置页 → 丢弃草稿并恢复即时预览的外观/语言（与"取消"按钮同语义）
      st.cancelSettings()
    }
    setView(view === 'settings' ? 'chat' : 'settings')
  }

  // 收起态：窄 rail，只保留展开按钮 + 图标化的"新建 / 设置"
  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button
          className="sidebar-toggle sidebar-toggle-collapsed"
          onClick={() => setSidebarCollapsed(false)}
          title={t('sidebar.expand')}
        >
          <PanelLeftOpen size={16} />
        </button>
        <button className="sidebar-rail-button" onClick={createSession} title={t('sidebar.newSession')}>
          <Plus size={16} />
        </button>
        <div className="sidebar-rail-spacer" />
        <button
          className={view === 'settings' ? 'sidebar-rail-button active' : 'sidebar-rail-button'}
          onClick={onSettingsClick}
          title={t('sidebar.settings')}
        >
          <Settings2 size={16} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      {/* 品牌 + 收起按钮 */}
      <div className="brand">
        <img className="brand-mark" src="./logo.png" alt="" />
        <strong>{t('app.name')}</strong>
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed(true)}
          title={t('sidebar.collapse')}
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      {/* 新建会话 */}
      <button className="new-session-button" onClick={createSession} title={t('sidebar.newSession')}>
        <Plus size={15} />
        {t('sidebar.newSession')}
      </button>

      {/* 会话列表 */}
      <nav className="session-nav" aria-label={t('app.name')}>
        {sessions.length === 0 && (
          <p className="sidebar-empty">{t('sidebar.noSessions')}</p>
        )}
        {sessions.map((s) => {
          const running = runningIds.has(s.id)
          return (
            <button
              key={s.id}
              className={s.id === activeSessionId ? 'active' : ''}
              title={running ? t('sidebar.running') : undefined}
              onClick={() => setActiveSession(s.id)}
            >
              {running
                ? <span className="session-spinner" />
                : <MessageSquare size={15} />}
              <span className="session-title">{s.title}</span>
              <span
                className="session-delete"
                title={t('sidebar.deleteSession')}
                // 弹确认框（防误操作），确认后才真正删除
                onClick={(e) => { e.stopPropagation(); requestDeleteSession(s.id) }}
              >
                <Trash2 size={12} />
              </span>
            </button>
          )
        })}
      </nav>

      {/* 底部设置入口 */}
      <button
        className={view === 'settings' ? 'sidebar-settings active' : 'sidebar-settings'}
        onClick={onSettingsClick}
      >
        <Settings2 size={15} />
        {t('sidebar.settings')}
      </button>

      {/* 右缘拖拽手柄（调整侧边栏宽度） */}
      <div
        className="sidebar-resizer"
        onMouseDown={onResizeStart}
        title={t('sidebar.resize')}
      />
    </aside>
  )
}
