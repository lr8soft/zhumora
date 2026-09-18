import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, MinusCircle, Scissors, Shrink, XCircle } from 'lucide-react'

import { useAppStore } from '../store'
import ChatComposer from './ChatComposer'
import MessageViewport, { EmptyConversationHero } from './MessageViewport'

export default function ChatView() {
  const { t } = useTranslation()
  const activeSessionId = useAppStore(s => s.activeSessionId)
  const sessions = useAppStore(s => s.sessions)
  const settings = useAppStore(s => s.settings)
  const isRunning = useAppStore(s => activeSessionId ? s.runningIds.has(activeSessionId) : false)
  const compactNotice = useAppStore(s => activeSessionId ? s.compactNotices[activeSessionId] : undefined)
  const truncatedNotice = useAppStore(s => activeSessionId ? s.truncatedNotices[activeSessionId] : undefined)
  const isCompacting = useAppStore(s => s.isCompacting)
  // 只订阅数量供压缩按钮判断；流式 token 修改内容时不重渲染 ChatView 外壳。
  const messageCount = useAppStore(s => activeSessionId ? (s.messages[activeSessionId]?.length ?? 0) : 0)
  const compactNow = useAppStore(s => s.compactNow)

  const activeSession = sessions.find(session => session.id === activeSessionId)
  const workspacePath = activeSession?.workspacePath || settings.workspacePath

  const handleChangeWorkspace = async () => {
    const directory = await window.api.settings.pickDirectory()
    if (directory && activeSessionId) {
      await window.api.session.updateWorkspace(activeSessionId, directory)
      void useAppStore.getState().loadSessions()
    }
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'n') {
        event.preventDefault()
        void useAppStore.getState().createSession()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (!activeSessionId) {
    return (
      <div className="chat-view">
        <div className="chat-messages" style={{ flex: 1 }}>
          <EmptyConversationHero workspacePath={settings.workspacePath} />
          <button
            className="btn-primary"
            style={{ marginTop: 20 }}
            onClick={() => void useAppStore.getState().createSession()}
          >
            {t('chat.newSession')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-view">
      <div className="chat-topbar">
        <div className="chat-topbar-left">
          <span className="chat-session-label">{t('chat.session')}</span>
          <span className="chat-session-title">{activeSession?.title || t('chat.newSession')}</span>
          <span className="chat-topbar-sep">|</span>
          <span className="chat-workspace" title={workspacePath}>
            <FolderOpen size={13} />
            <span>{workspacePath}</span>
          </span>
          <button className="chat-workspace-change" onClick={handleChangeWorkspace}>
            {t('chat.changeWorkspace')}
          </button>
        </div>
        <div className="chat-topbar-right">
          <button
            className={isCompacting ? 'compact-chip compacting' : 'compact-chip'}
            onClick={() => void compactNow()}
            disabled={isRunning || isCompacting || messageCount < 10}
            title={isCompacting ? t('chat.compactWorking') : t('chat.compactNowHint')}
          >
            {isCompacting ? <span className="spinner" /> : <Shrink size={13} />}
            {isCompacting ? t('chat.compactWorking') : t('chat.compactNow')}
          </button>
          {isRunning && (
            <span className="thinking">
              <span className="pulse-dot" />
              {t('chat.thinking')}
            </span>
          )}
        </div>
      </div>

      {compactNotice && (
        <div className={`compact-notice ${compactNotice.error ? 'error' : ''}`}>
          {compactNotice.error ? <XCircle size={14} /> : <MinusCircle size={14} />}
          <span>
            {compactNotice.error
              ? `${t('chat.compactError')}: ${compactNotice.error}`
              : t('chat.compactNotice', {
                  before: compactNotice.beforeTokens.toLocaleString(),
                  after: compactNotice.afterTokens.toLocaleString(),
                  compressed: compactNotice.compressedCount,
                  kept: compactNotice.keptCount
                })}
          </span>
        </div>
      )}

      {truncatedNotice && (
        <div className="truncated-notice">
          <Scissors size={14} />
          <span>{t(
            truncatedNotice.kind === 'tool'
              ? (truncatedNotice.reason === 'stream' ? 'chat.streamInterruptedTool' : 'chat.truncatedTool')
              : (truncatedNotice.reason === 'stream' ? 'chat.streamInterruptedText' : 'chat.truncatedText')
          )}</span>
        </div>
      )}

      <MessageViewport key={activeSessionId} sessionId={activeSessionId} />
      <ChatComposer sessionId={activeSessionId} />
    </div>
  )
}
