import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { ChevronDown, ChevronRight, ChevronUp, Brain, Terminal, Wrench, XCircle, Archive } from 'lucide-react'
import type { UIMessage, ToolCall } from '@shared/types'
import { COMPACT_SUMMARY_PREFIX } from '@shared/types'

interface Props {
  message: UIMessage
  /** 工具调用状态（按 toolCall.id 索引，由 ChatView 计算） */
  toolStatuses?: Record<string, 'done' | 'error'>
  /** 工具调用结果（按 toolCall.id 索引，由 ChatView 从 role=tool 消息聚合，合并进折叠块展示） */
  toolResults?: Record<string, { content: string; isError: boolean }>
  /** 当前会话的重试状态（按会话传入，避免后台并行会话的状态串到前台） */
  retryStatus?: { failedAttempt: number; maxRetries: number }
}

export default function MessageBubble({ message, toolStatuses, toolResults, retryStatus }: Props) {
  const { t } = useTranslation()

  // 上下文压缩摘要消息：以 user 角色存库，但渲染为可折叠的系统摘要块（默认收起）
  if (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(COMPACT_SUMMARY_PREFIX)) {
    const body = message.content.slice(COMPACT_SUMMARY_PREFIX.length).trim()
    return <CompactSummaryBlock summary={body} />
  }

  // 用户消息（可含图片附件）
  if (message.role === 'user') {
    return (
      <div className="message-user">
        {message.images && message.images.length > 0 && (
          <div className="message-user-images">
            {message.images.map((src, i) => (
              <img key={i} src={src} alt="" loading="lazy" />
            ))}
          </div>
        )}
        {message.content && <div className="bubble">{message.content}</div>}
      </div>
    )
  }

  // 工具结果消息：正常路径已合并进工具调用折叠块（ChatView 跳过渲染），
  // 走到这里的是孤儿结果（找不到对应 tool_call 消息，如历史清洗后的遗留）
  if (message.role === 'tool') {
    return <ToolResultBlock toolName={message.toolName || message.toolCallId || ''} content={message.content} isError={message.status === 'error'} />
  }

  const hasReasoning = !!message.reasoning

  // 助手消息（可能包含 toolCalls）
  return (
    <div className="message-assistant">
      {/* 头部：纯思考/工具轮（无正文）不显示 logo 头部，避免气泡碎片化 */}
      {message.content || !hasReasoning ? (
        <div className="assistant-head">
          <span className="assistant-name"><img className="assistant-logo" src="./logo.png" alt="" />{t('app.name')}</span>
          {message.status === 'streaming' && <span className="pulse-dot" />}
          {message.status === 'error' && (
            <span className="assistant-status error">{t('message.error')}</span>
          )}
        </div>
      ) : null}

      {/* 深度思考块（模型 reasoning 内容；放在正文之前，默认折叠只显示最新一行，点击展开全文） */}
      {hasReasoning ? (
        <ThinkingBlock reasoning={message.reasoning!} streaming={message.status === 'streaming' || message.status === 'thinking'} />
      ) : message.status === 'thinking' ? (
        <div className="thinking-line">
          <span className="spinner" />
          {retryStatus
            ? t('chat.retrying', { attempt: retryStatus.failedAttempt, max: retryStatus.maxRetries < 0 ? '∞' : retryStatus.maxRetries })
            : t('chat.thinking')}
        </div>
      ) : null}

      {/* 正文内容 */}
      {message.content ? (
        <div className="markdown-body">
          <ReactMarkdown>{message.content}</ReactMarkdown>
        </div>
      ) : null}

      {/* 工具调用列表（结果合并进各自的折叠块，默认收起不显示返回信息） */}
      {message.toolCalls?.map(tc => (
        <ToolCallRow
          key={tc.id}
          toolCall={tc}
          status={toolStatuses?.[tc.id]}
          result={toolResults?.[tc.id]}
        />
      ))}
    </div>
  )
}

/* ---------- 深度思考块（reasoning）----------
 * 默认折叠：只显示"深度思考 + 最新一行"；点击展开看完整思考（Markdown 渲染、可滚动）。
 * 流式期间最新一行实时滚动更新。
 */
function ThinkingBlock({ reasoning, streaming }: { reasoning: string; streaming: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 折叠预览：取最后一个非空行（CSS 单行省略）
  const lastLine = useMemo(() => {
    const lines = reasoning.split('\n').map(l => l.trim()).filter(Boolean)
    return lines[lines.length - 1] || ''
  }, [reasoning])
  // 展开期间流式输出时自动滚到底部
  useEffect(() => {
    if (expanded && streaming && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [reasoning, expanded, streaming])

  return (
    <div className={`thinking-block ${streaming ? 'streaming' : ''}`}>
      <button className="thinking-block-header" onClick={() => setExpanded(!expanded)}>
        <Brain size={13} className="thinking-block-icon" />
        <span className="thinking-block-label">{t('chat.thinkingBlock')}</span>
        {streaming && <span className="pulse-dot" />}
        <span className="thinking-block-preview">{lastLine}</span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded && (
        <div className="thinking-block-body" ref={bodyRef}>
          <ReactMarkdown>{reasoning}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}

/* ---------- 工具调用折叠块 ----------
 * 默认折叠：只显示 状态点 + 工具名 + 状态（不显示参数和返回信息），
 * 点击展开看完整参数 + 执行结果。工具结果消息由 ChatView 聚合后传入，
 * 不再在时间线里单独占据大块，保持对话流紧凑。
 */
function ToolCallRow({ toolCall, status, result }: {
  toolCall: ToolCall
  status?: 'done' | 'error'
  result?: { content: string; isError: boolean }
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const statusClass = status === 'done' ? 'done' : status === 'error' ? 'error' : 'running'
  const statusLabel = status === 'done'
    ? t('chat.tool.done')
    : status === 'error'
      ? t('chat.tool.error')
      : t('chat.tool.running')

  const hasBody = !!(result || toolCall.function.arguments)

  return (
    <div className={`tool-call ${statusClass}`}>
      <button className="tool-call-header" onClick={() => hasBody && setExpanded(!expanded)} disabled={!hasBody}>
        <span className="dot" />
        <Wrench size={12} />
        <span className="tool-call-name">{toolCall.function.name}</span>
        <span className={`tool-call-status ${statusClass}`}>
          {status === 'error' && <XCircle size={11} />}
          {statusLabel}
        </span>
        {hasBody && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
      {expanded && (
        <div className="tool-call-body">
          {toolCall.function.arguments && (
            <>
              <div className="tool-call-section-label">{t('chat.tool.args')}</div>
              <pre className="tool-call-pre">{toolCall.function.arguments}</pre>
            </>
          )}
          {result && (
            <>
              <div className={`tool-call-section-label ${result.isError ? 'error' : ''}`}>
                {result.isError ? t('chat.tool.error') : t('chat.tool.result')}
              </div>
              <pre className="tool-call-pre">{result.content}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- 上下文压缩摘要块（默认收起，点击展开查看全文） ---------- */
function CompactSummaryBlock({ summary }: { summary: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  // 较长摘要提供展开/收起；短摘要单行预览即可
  const isLong = summary.length > 160

  return (
    <div className="compact-summary">
      <div className="compact-summary-inner">
        <button className="compact-summary-header" onClick={() => isLong && setExpanded(!expanded)} disabled={!isLong}>
          <Archive size={13} />
          <span className="compact-summary-title">{t('compact.label')}</span>
          {!expanded && (
            <span className="compact-summary-preview">{summary}</span>
          )}
          {isLong && (
            <span className="compact-summary-toggle">
              {expanded ? t('message.collapse') : t('message.expand')}
              {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
            </span>
          )}
        </button>
        {expanded && (
          <div className="compact-summary-body">
            <ReactMarkdown>{summary}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------- 孤儿工具结果块（正常路径不渲染；仅历史遗留的无主 tool 消息兜底） ---------- */
function ToolResultBlock({ toolName, content, isError }: { toolName: string; content: string; isError: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const long = content.length > 500

  return (
    <div className={`tool-result ${isError ? 'error' : ''}`}>
      <div className="tool-result-header">
        <span className="tool-result-title">
          {isError ? <XCircle size={12} /> : <Terminal size={12} />}
          {toolName}
        </span>
        {long && (
          <button className="tool-result-toggle" onClick={() => setExpanded(!expanded)}>
            {expanded ? t('message.collapse') : t('message.expand')}
            {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        )}
      </div>
      <pre className="tool-result-body">{expanded || !long ? content : content.slice(0, 500) + '...'}</pre>
    </div>
  )
}
