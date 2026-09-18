import React, { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, ArrowDown, ChevronDown, ChevronUp } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

import type { UIMessage } from '@shared/types'
import { useAppStore } from '../store'
import { buildTimelineRows, type TimelineRow } from '../timeline'
import MessageBubble from './MessageBubble'
import ToolCallChain from './ToolCallChain'

const EMPTY_MESSAGES: UIMessage[] = []
const VIEWPORT_PADDING = { top: 360, bottom: 520 }
const VIRTUOSO_COMPONENTS = { EmptyPlaceholder: EmptyConversation }

interface Props {
  sessionId: string
}

/** 长历史渲染边界。仅挂载视口附近的动态高度消息行。 */
function MessageViewport({ sessionId }: Props) {
  const { t } = useTranslation()
  const messages = useAppStore(s => s.messages[sessionId] ?? EMPTY_MESSAGES)
  const isRunning = useAppStore(s => s.runningIds.has(sessionId))
  const retryStatus = useAppStore(s => s.retryStatus[sessionId])
  const compaction = useAppStore(s => s.compactionMarkers[sessionId])
  const rows = useMemo(() => buildTimelineRows(messages, {
    sessionId,
    isRunning,
    retryStatus,
    compaction
  }), [messages, sessionId, isRunning, retryStatus, compaction])

  const listRef = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)

  const scrollToBottom = () => {
    if (rows.length === 0) return
    listRef.current?.scrollToIndex({ index: rows.length - 1, align: 'end', behavior: 'smooth' })
  }

  return (
    <div className="message-viewport">
      <Virtuoso
        ref={listRef}
        className="chat-messages"
        data={rows}
        computeItemKey={(_, row) => row.key}
        itemContent={(index, row) => (
          <div className={`chat-timeline-row${index === 0 ? ' first' : ''}${index === rows.length - 1 ? ' last' : ''}`}>
            <TimelineRowView row={row} />
          </div>
        )}
        components={VIRTUOSO_COMPONENTS}
        initialTopMostItemIndex={rows.length > 0 ? rows.length - 1 : undefined}
        increaseViewportBy={VIEWPORT_PADDING}
        atBottomThreshold={80}
        atBottomStateChange={setAtBottom}
        followOutput={isAtBottom => isAtBottom ? 'auto' : false}
      />
      {!atBottom && rows.length > 0 && (
        <button className="scroll-to-bottom" onClick={scrollToBottom} title={t('chat.scrollToBottom')}>
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  )
}

export default React.memo(MessageViewport)

/** 空会话 hero：Codex 的大标题引导（"你想让我们在 X 中构建什么？"，X = 工作目录名） */
export function EmptyConversationHero({ workspacePath }: { workspacePath?: string }) {
  const { t } = useTranslation()
  const title = useMemo(() => {
    const normalized = (workspacePath || '').replace(/[\\/]+$/, '')
    const name = normalized ? (normalized.split(/[\\/]/).filter(Boolean).pop() || normalized) : ''
    return name ? t('chat.heroPrompt', { workspace: name }) : t('app.name')
  }, [workspacePath, t])
  return (
    <div className="chat-empty">
      <img className="empty-mark" src="./logo.png" alt="" />
      <h2>{title}</h2>
      <p>{t('chat.welcomeHint')}</p>
    </div>
  )
}

function EmptyConversation() {
  const { t } = useTranslation()
  const sessionId = useAppStore(s => s.activeSessionId)
  const session = useAppStore(s => s.sessions.find(x => x.id === sessionId))
  const settings = useAppStore(s => s.settings)
  return (
    <EmptyConversationHero workspacePath={session?.workspacePath || settings.workspacePath} />
  )
}

const TimelineRowView = React.memo(function TimelineRowView({ row }: { row: TimelineRow }) {
  const { t } = useTranslation()
  if (row.type === 'message') {
    return (
      <MessageBubble
        message={row.message}
        toolStatuses={row.toolStatuses}
        toolResults={row.toolResults}
        retryStatus={row.retryStatus}
      />
    )
  }
  if (row.type === 'chain') return <ToolCallChain row={row} />
  if (row.type === 'compaction') return <CompactFoldedMarker />
  return (
    <div className="retry-status">
      <span className="spinner" />
      <span>{t('chat.retrying', {
        attempt: row.status.failedAttempt,
        max: row.status.maxRetries < 0 ? '∞' : row.status.maxRetries
      })}</span>
    </div>
  )
}, sameTimelineRow)

function sameTimelineRow(previous: { row: TimelineRow }, next: { row: TimelineRow }): boolean {
  const a = previous.row
  const b = next.row
  if (a.type !== b.type || a.key !== b.key) return false
  if (a.type === 'compaction' && b.type === 'compaction') return true
  if (a.type === 'chain' && b.type === 'chain') {
    // key 取首个成员 id（稳定），revision 覆盖节点结果落位/状态翻转/成员追加
    return a.revision === b.revision
  }
  if (a.type === 'retry' && b.type === 'retry') {
    return a.status.failedAttempt === b.status.failedAttempt && a.status.maxRetries === b.status.maxRetries
  }
  if (a.type === 'message' && b.type === 'message') {
    return a.message === b.message
      && a.toolRevision === b.toolRevision
      && a.retryStatus?.failedAttempt === b.retryStatus?.failedAttempt
      && a.retryStatus?.maxRetries === b.retryStatus?.maxRetries
  }
  return false
}

function CompactFoldedMarker() {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="compact-summary">
      <div className="compact-summary-inner">
        <button className="compact-summary-header" onClick={() => setExpanded(!expanded)}>
          <Archive size={13} />
          <span className="compact-summary-title">{t('compact.folded')}</span>
          <span className="compact-summary-toggle">
            {expanded ? t('message.collapse') : t('message.expand')}
            {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </span>
        </button>
        {expanded && (
          <div className="compact-summary-body">
            <p>{t('compact.foldedHint')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
