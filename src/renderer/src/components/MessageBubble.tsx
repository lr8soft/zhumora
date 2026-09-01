import React, { useEffect, useMemo, useRef, useState } from 'react'
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

function MessageBubble({ message, toolStatuses, toolResults, retryStatus }: Props) {
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

// React.memo：流式期间每个 flush 只有"内容变化的那一条" message 引用会变，
// 其余消息引用不变 → memo 浅比较直接跳过，避免整列表所有气泡
// 都重新执行组件函数 + 重解析 Markdown（长会话卡顿的另一大根因）。
export default React.memo(MessageBubble)

/* ---------- 深度思考块（reasoning）----------
 * 默认折叠：只显示"深度思考 + 最新一行"；点击展开看完整思考（Markdown 渲染、可滚动）。
 * 流式期间最新一行实时滚动更新。
 */
function ThinkingBlock({ reasoning, streaming }: { reasoning: string; streaming: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 折叠预览：取最后一个非空行（CSS 单行省略，与 split 版语义一致）。
  // 增量计算：换行位置只在"新增区间"内回扫，行尾回退扫描的代价受
  // 尾部空行数约束 —— 避免每个 flush 都对整段思考文本（可达数万字符）split，
  // O(全文长) → O(增量)。
  // 前缀守卫：phase=end 的权威值可能覆盖 UI 累积值且前缀分叉（个别 chunk
  // 丢失时），此时 startsWith 不成立 → 全量重算一次，之后恢复增量。
  // startsWith 是原生 memcmp 级操作（5 万字符 ~50µs），远低于旧实现的
  // split + 数千个子串分配。
  const prevText = useRef('')
  const nlState = useRef({ upTo: 0, lastNewline: -1 })
  const lastLine = useMemo(() => {
    const s = nlState.current
    if (!reasoning.startsWith(prevText.current)) {
      s.upTo = 0
      s.lastNewline = -1
    }
    const L = reasoning.length
    const isNL = (i: number) => reasoning.charCodeAt(i) === 10
    // 行边界空白：对齐原实现 trim() 的语义（space / tab / \r）
    const isSp = (c: number) => c === 32 || c === 9 || c === 13
    // 定位最后一个换行（热路径只扫新增区间 [upTo, L)）
    let lastNewline = s.lastNewline
    for (let i = L - 1; i >= s.upTo; i--) {
      if (isNL(i)) { lastNewline = i; break }
    }
    // 末行 = [lastNewline+1, L)，两端去空白
    let ls = lastNewline + 1
    while (ls < L && isSp(reasoning.charCodeAt(ls))) ls++
    let le = L
    while (le > ls && isSp(reasoning.charCodeAt(le - 1))) le--
    let text = ls < le ? reasoning.slice(ls, le) : ''
    if (!text && lastNewline >= 0) {
      // 末行为空（文本以换行结尾）→ 回退到最近一个非空行
      let end = lastNewline
      for (;;) {
        let e = end
        while (e > 0 && !isNL(e - 1)) e--
        let a = e, b = end
        while (a < b && isSp(reasoning.charCodeAt(a))) a++
        while (b > a && isSp(reasoning.charCodeAt(b - 1))) b--
        if (a < b) { text = reasoning.slice(a, b); break }
        if (e === 0) break
        end = e - 1 // char(e-1) 是换行 → 越过它看上一行
      }
    }
    s.upTo = L
    s.lastNewline = lastNewline
    prevText.current = reasoning
    return text
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
