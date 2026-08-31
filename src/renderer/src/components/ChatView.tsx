import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, BrainCircuit, FolderOpen, ImagePlus, Shield, ShieldCheck, ShieldOff, Square, X, MinusCircle, Shrink, XCircle, Archive, ChevronDown, ChevronUp, Scissors } from 'lucide-react'

import { processImageFile, ImageAttachmentError, MAX_IMAGES } from '../utils/image'
import { useAppStore, INPUT_MIN_HEIGHT, INPUT_MAX_HEIGHT } from '../store'
import MessageBubble from './MessageBubble'
import type { AutoApproveMode, UIMessage } from '@shared/types'

const EMPTY_MESSAGES: UIMessage[] = []

export default function ChatView() {
  const { t } = useTranslation()
  const activeSessionId = useAppStore(s => s.activeSessionId)
  // 按会话切片订阅：只有"当前显示会话"的数据变化才触发重渲染，
  // 后台并行会话的消息累积不会干扰当前视图
  const messages = useAppStore(s => (activeSessionId ? (s.messages[activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES))
  const isRunning = useAppStore(s => (activeSessionId ? s.runningIds.has(activeSessionId) : false))
  const retryStatus = useAppStore(s => (activeSessionId ? s.retryStatus[activeSessionId] : undefined))
  const compactNotice = useAppStore(s => (activeSessionId ? s.compactNotices[activeSessionId] : undefined))
  // 压缩标记：upToMessageId 之前的历史在 LLM 上下文中被摘要折叠（消息表不变）
  const compaction = useAppStore(s => (activeSessionId ? s.compactionMarkers[activeSessionId] : undefined))
  // 单轮输出被 max_tokens 截断的通知（自动消失）
  const truncatedNotice = useAppStore(s => (activeSessionId ? s.truncatedNotices[activeSessionId] : undefined))
  const { sessions, settings, selectedProviderModel, setSelectedProviderModel, approveMode, setApproveMode, isCompacting, sendMessage, abortAgent, compactNow } = useAppStore()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const inputAreaRef = useRef<HTMLDivElement>(null)
  // 输入区固定高度（0 = 自适应内容）；拖拽上缘调整，持久化在 store
  const inputAreaHeight = useAppStore(s => s.inputAreaHeight)
  const setInputAreaHeight = useAppStore(s => s.setInputAreaHeight)
  // 待发送的图片附件（base64 data URL，发送前暂存在输入区预览）
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 批准模式下拉是否展开（向上弹出，贴工具栏上方）
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  // 模型选择下拉是否展开（向上弹出；原生 select 弹出方向不可控，改自定义菜单）
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  // 思考强度下拉是否展开
  const [effortMenuOpen, setEffortMenuOpen] = useState(false)
  const enabledProviders = settings.providers.filter(p => p.enabled)
  // 当前生效 provider（聊天页选择优先，否则 active provider）
  const spmParts = selectedProviderModel?.split('::')
  const activeRunProvider = enabledProviders.find(p => p.id === spmParts?.[0])
    || enabledProviders.find(p => p.id === settings.activeProviderId)
  const reasoningSupported = activeRunProvider?.reasoningEnabled === true
  const reasoningEffort = useAppStore(s => s.reasoningEffort)
  const setReasoningEffort = useAppStore(s => s.setReasoningEffort)

  // 当前 session 的工作目录
  const activeSession = sessions.find(s => s.id === activeSessionId)
  const workspacePath = activeSession?.workspacePath || settings.workspacePath

  const handleChangeWorkspace = async () => {
    const dir = await window.api.settings.pickDirectory()
    if (dir && activeSessionId) {
      await window.api.session.updateWorkspace(activeSessionId, dir)
      // 重新加载 sessions 列表以更新 workspacePath
      useAppStore.getState().loadSessions()
    }
  }

  // 自动滚到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, retryStatus])

  // 快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+N 新建会话
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault()
        useAppStore.getState().createSession()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // 切换会话时清空未发送的附件（它们不属于新会话）
  useEffect(() => {
    setPendingImages([])
    setImageError(null)
  }, [activeSessionId])

  // textarea 自适应内容高度（inputAreaHeight=0 时生效；固定高度时清空 inline height，交给 CSS flex 接管）
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (inputAreaHeight > 0) {
      el.style.height = ''
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [input, pendingImages.length, inputAreaHeight, activeSessionId])

  const handleSubmit = () => {
    const text = input.trim()
    if ((!text && pendingImages.length === 0) || isRunning) return
    sendMessage(text, pendingImages.length > 0 ? [...pendingImages] : undefined)
    setInput('')
    setPendingImages([])
    setImageError(null)
  }

  /** 添加图片附件（粘贴 / 拖放 / 文件选择，统一入口；内部做类型、大小、缩放校验） */
  const addImages = async (files: File[]) => {
    if (isRunning) return
    const room = MAX_IMAGES - pendingImages.length
    if (room <= 0) {
      setImageError(t('chat.imageLimit', { max: MAX_IMAGES }))
      return
    }
    setImageError(null)
    const processed: string[] = []
    for (const file of files.slice(0, room)) {
      try {
        processed.push(await processImageFile(file))
      } catch (err) {
        const code = err instanceof ImageAttachmentError ? err.code : 'decode-failed'
        const errorKey = {
          'unsupported-type': 'chat.imageErrorUnsupported',
          'too-large': 'chat.imageErrorTooLarge',
          'decode-failed': 'chat.imageErrorDecode'
        }[code]
        setImageError(t(errorKey))
        break
      }
    }
    if (processed.length > 0) {
      setPendingImages(prev => [...prev, ...processed])
    }
  }

  /** 拖拽输入区上缘调整高度：document 级监听，松手即清理（clamp + 持久化在 store 内）。
   *  单击手柄（位移 < 4px）= 恢复自适应高度 */
  const onInputResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startArea = inputAreaRef.current?.getBoundingClientRect().height ?? 0
    let moved = false
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY // 向上拖为正
      if (Math.abs(delta) >= 4) moved = true
      if (!moved) return
      setInputAreaHeight(startArea + delta)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (!moved) setInputAreaHeight(0) // 单击手柄 → 恢复自适应
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  /** 粘贴图片（如截图） */
  const handlePaste = (e: React.ClipboardEvent) => {
    if (isRunning) return
    const files: File[] = []
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      void addImages(files)
    }
  }

  /** 拖放图片 */
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (isRunning) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) void addImages(files)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // 工具调用状态：从工具结果消息按 toolCallId 匹配
  const toolStatuses = useMemo(() => {
    const map: Record<string, 'done' | 'error'> = {}
    for (const m of messages) {
      if (m.role === 'tool' && m.toolCallId) {
        map[m.toolCallId] = m.status === 'error' ? 'error' : 'done'
      }
    }
    return map
  }, [messages])

  // 工具调用结果：按 toolCallId 聚合（合并进工具调用折叠块内展示，
  // 时间线里不再单独渲染大块工具结果，保持对话流紧凑）
  const toolResults = useMemo(() => {
    const map: Record<string, { content: string; isError: boolean }> = {}
    for (const m of messages) {
      if (m.role === 'tool' && m.toolCallId) {
        map[m.toolCallId] = { content: m.content, isError: m.status === 'error' }
      }
    }
    return map
  }, [messages])

  // 被 assistant 消息 tool_calls 引用的 tool_call id 集合。
  // 有主的结果 → 已并入工具调用折叠块，时间线里跳过；孤儿结果（无主）→ 兜底显示
  const referencedToolCallIds = useMemo(() => {
    const set = new Set<string>()
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) if (tc.id) set.add(tc.id)
      }
    }
    return set
  }, [messages])

  // 无活跃会话
  if (!activeSessionId) {
    return (
      <div className="chat-view">
        <div className="chat-messages" style={{ flex: 1 }}>
          <div className="chat-empty">
            <img className="empty-mark" src="./logo.png" alt="" />
            <h2>{t('app.name')}</h2>
            <p>{t('chat.createSessionToStart')}</p>
            <button className="btn-primary" style={{ marginTop: 16 }} onClick={() => useAppStore.getState().createSession()}>
              {t('chat.newSession')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  /** 批准模式图标 + 颜色映射 */
  const modeIcon = (mode: AutoApproveMode) => {
    switch (mode) {
      case 'manual': return <ShieldOff size={13} />
      case 'auto': return <Shield size={13} />
      case 'full': return <ShieldCheck size={13} />
    }
  }

  const modeLabel = (mode: AutoApproveMode) => {
    switch (mode) {
      case 'manual': return t('chat.approveManual')
      case 'auto': return t('chat.approveAuto')
      case 'full': return t('chat.approveFull')
    }
  }

  const modeHint = (mode: AutoApproveMode) => {
    switch (mode) {
      case 'manual': return t('chat.approveManualHint')
      case 'auto': return t('chat.approveAutoHint')
      case 'full': return t('chat.approveFullHint')
    }
  }

  return (
    <div className="chat-view">
      {/* 顶部栏 */}
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
          {/* 手动压缩上下文按钮（模仿 Cline：将早期消息合并为摘要，释放上下文空间） */}
          <button
            className={isCompacting ? 'compact-chip compacting' : 'compact-chip'}
            onClick={() => void compactNow()}
            disabled={isRunning || isCompacting || messages.length < 10}
            title={isCompacting ? t('chat.compactWorking') : t('chat.compactNowHint')}
          >
            {isCompacting ? (
              <span className="spinner" />
            ) : (
              <Shrink size={13} />
            )}
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

      {/* 上下文压缩通知条（成功 / 失败） */}
      {compactNotice && (
        <div className={`compact-notice ${compactNotice.error ? 'error' : ''}`}>
          {compactNotice.error
            ? <XCircle size={14} />
            : <MinusCircle size={14} />}
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

      {/* 输出截断通知条（单轮达到 max_tokens 上限；自动消失） */}
      {truncatedNotice && (
        <div className="truncated-notice">
          <Scissors size={14} />
          <span>{t(truncatedNotice.kind === 'tool' ? 'chat.truncatedTool' : 'chat.truncatedText')}</span>
        </div>
      )}

      {/* 消息流 */}
      <div ref={scrollRef} className="chat-messages">
        <div className="chat-inner">
          {messages.length === 0 && (
            <div className="chat-empty">
              <img className="empty-mark" src="./logo.png" alt="" />
              <h2>{t('app.name')}</h2>
              <p>{t('chat.welcome')}</p>
              <small>{t('chat.welcomeHint')}</small>
            </div>
          )}
          {messages.map((msg, i) => (
            <React.Fragment key={msg.id}>
              {/* 有主工具结果不单独渲染（已合并进工具调用折叠块）；孤儿结果仍兜底显示 */}
              {!(msg.role === 'tool' && msg.toolCallId && referencedToolCallIds.has(msg.toolCallId)) && (
                <MessageBubble message={msg} toolStatuses={toolStatuses} toolResults={toolResults} retryStatus={retryStatus} />
              )}
              {/* 压缩标记：渲染在边界消息之后。完整历史仍可见，
                  标记仅说明"此处的历史在发给 LLM 时已被摘要折叠" */}
              {compaction && msg.id === compaction.upToMessageId && i < messages.length - 1 && (
                <CompactFoldedMarker />
              )}
            </React.Fragment>
          ))}
          {/* 重试状态行（思考占位已被移除时显示，如工具轮之间的重试） */}
          {retryStatus && isRunning && !messages.some(m => m.status === 'thinking') && (
            <div className="retry-status">
              <span className="spinner" />
              <span>{t('chat.retrying', { attempt: retryStatus.failedAttempt, max: retryStatus.maxRetries < 0 ? '∞' : retryStatus.maxRetries })}</span>
            </div>
          )}
        </div>
      </div>

      {/* 输入区（Codex desktop 风格：卡片式 composer，工具栏固定在卡片底部；
          上缘可拖拽调高——只有 textarea 吸收高度变化，按钮大小不动；
          单击上缘手柄恢复自适应） */}
      <div
        ref={inputAreaRef}
        className="chat-input-area"
        style={inputAreaHeight > 0 ? { height: `${inputAreaHeight}px` } : undefined}
      >
        <div
          className="chat-input-resizer"
          onMouseDown={onInputResizeStart}
          title={t('chat.inputResizeHint')}
        />
        <div className="composer" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
          {/* 图片附件预览（卡片内顶部） */}
          {pendingImages.length > 0 && (
            <div className="chat-image-previews">
              {pendingImages.map((src, i) => (
                <span key={i} className="chat-image-preview">
                  <img src={src} alt="" />
                  <button
                    className="chat-image-remove"
                    title={t('chat.removeImage')}
                    onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {imageError && <p className="chat-image-error">{imageError}</p>}

          {/* 文本区（拖拽调高时唯一吸收变化的元素） */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('chat.inputPlaceholder')}
            className="chat-textarea"
            rows={1}
          />

          {/* 底部工具栏（固定尺寸，不随拖拽变化） */}
          <div className="composer-toolbar">
            <button
              className="composer-icon-btn"
              title={t('chat.attachImage')}
              onClick={() => fileInputRef.current?.click()}
              disabled={isRunning || pendingImages.length >= MAX_IMAGES}
            >
              <ImagePlus size={17} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="attach-file-input"
              onChange={(e) => {
                if (e.target.files) void addImages(Array.from(e.target.files))
                e.target.value = ''
              }}
            />
            {/* 批准模式下拉（从 topbar 移入 composer，对齐 Codex 布局） */}
            <div className="mode-selector">
              <button
                className={approveMode === 'full' ? 'composer-mode-chip mode-full' : approveMode === 'auto' ? 'composer-mode-chip mode-auto' : 'composer-mode-chip'}
                onClick={() => setModeMenuOpen(!modeMenuOpen)}
                title={modeHint(approveMode)}
              >
                {modeIcon(approveMode)}
                {modeLabel(approveMode)}
              </button>
              {modeMenuOpen && (
                <>
                  <div className="mode-menu-backdrop" onClick={() => setModeMenuOpen(false)} />
                  <div className="mode-menu">
                    {(['manual', 'auto', 'full'] as AutoApproveMode[]).map(mode => (
                      <button
                        key={mode}
                        className={mode === approveMode ? 'mode-menu-item active' : 'mode-menu-item'}
                        onClick={() => { setApproveMode(mode); setModeMenuOpen(false) }}
                        title={modeHint(mode)}
                      >
                        {modeIcon(mode)}
                        <span className="mode-menu-label">
                          <strong>{modeLabel(mode)}</strong>
                          <small>{modeHint(mode)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="composer-toolbar-spacer" />
            {/* 思考强度（仅当前 provider 开启该功能时显示；自定义菜单向上展开） */}
            {reasoningSupported && (
              <div className="mode-selector">
                <button
                  className={reasoningEffort === 'high' ? 'composer-effort-chip effort-high' : reasoningEffort === 'low' ? 'composer-effort-chip effort-low' : 'composer-effort-chip'}
                  onClick={() => setEffortMenuOpen(!effortMenuOpen)}
                  title={t('chat.reasoningEffortHint')}
                >
                  <BrainCircuit size={14} />
                  {t(`chat.reasoningEffort.${reasoningEffort}`)}
                </button>
                {effortMenuOpen && (
                  <>
                    <div className="mode-menu-backdrop" onClick={() => setEffortMenuOpen(false)} />
                    <div className="mode-menu effort-menu">
                      {(['off', 'low', 'medium', 'high'] as const).map(effort => (
                        <button
                          key={effort}
                          className={effort === reasoningEffort ? 'mode-menu-item active' : 'mode-menu-item'}
                          onClick={() => { setReasoningEffort(effort); setEffortMenuOpen(false) }}
                        >
                          <span className="effort-menu-label">{t(`chat.reasoningEffort.${effort}`)}</span>
                          <small className="effort-menu-desc">{t(`chat.reasoningEffortDesc.${effort}`)}</small>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {/* Provider/模型选择（自定义菜单，向上展开贴工具栏上方） */}
            <div className="mode-selector">
              <button
                className="composer-model-select"
                onClick={() => setModelMenuOpen(!modelMenuOpen)}
                title={t('chat.selectModelHint')}
              >
                <span className="composer-model-name">
                  {selectedProviderModel
                    ? (enabledProviders.find(p => p.id === selectedProviderModel.split('::')[0])?.name || '') + ' · ' + selectedProviderModel.split('::')[1]
                    : t('chat.defaultModel')}
                </span>
                <ChevronDown size={12} className={modelMenuOpen ? 'chevron-up' : ''} />
              </button>
              {modelMenuOpen && (
                <>
                  <div className="mode-menu-backdrop" onClick={() => setModelMenuOpen(false)} />
                  <div className="mode-menu model-menu">
                    <button
                      className={selectedProviderModel === null ? 'mode-menu-item active' : 'mode-menu-item'}
                      onClick={() => { setSelectedProviderModel(null); setModelMenuOpen(false) }}
                    >
                      {t('chat.defaultModel')}
                    </button>
                    {enabledProviders.map(p => (
                      <button
                        key={p.id}
                        className={selectedProviderModel === `${p.id}::${p.defaultModel}` ? 'mode-menu-item active' : 'mode-menu-item'}
                        onClick={() => { setSelectedProviderModel(`${p.id}::${p.defaultModel}`); setModelMenuOpen(false) }}
                      >
                        {p.name} · {p.defaultModel}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {/* 发送 / 停止（运行中切换为停止按钮） */}
            <button
              className={isRunning ? 'composer-send stop' : 'composer-send'}
              onClick={isRunning ? abortAgent : handleSubmit}
              disabled={!isRunning && (!input.trim() && pendingImages.length === 0)}
              title={isRunning ? t('chat.stop') : t('chat.send')}
            >
              {isRunning ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------- 上下文压缩标记 ----------
 * 渲染在压缩边界消息之后。说明：此消息及之前的历史在发送给 LLM 时
 * 已被折叠为一段摘要（节省上下文空间），但界面上完整历史仍然可见，
 * 不会被删除 —— 对齐 Cline / opencode 的"压缩只影响 LLM 上下文"语义。
 */
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
