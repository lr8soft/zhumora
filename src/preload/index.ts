// ============================================================
// Preload — 安全暴露 IPC 到渲染进程
// 通过 contextBridge 暴露最小化 API surface
// ============================================================
import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, Session, UIMessage, UserMessageInput, AutoApproveMode, ReasoningEffort, TelegramBotConfig } from '../shared/types'

const api = {
  // ============================================================
  // Session 管理
  // ============================================================
  session: {
    create: (title?: string): Promise<Session> =>
      ipcRenderer.invoke('session:create', title),
    list: (): Promise<Session[]> =>
      ipcRenderer.invoke('session:list'),
    get: (id: string): Promise<Session | null> =>
      ipcRenderer.invoke('session:get', id),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('session:delete', id),
    rename: (id: string, title: string): Promise<boolean> =>
      ipcRenderer.invoke('session:rename', id, title),
    messages: (id: string): Promise<UIMessage[]> =>
      ipcRenderer.invoke('session:messages', id),
    /** 会话的压缩状态（边界消息 id + 摘要）；无压缩返回 null */
    compaction: (id: string): Promise<{ upToMessageId: string; summary: string; createdAt: number } | null> =>
      ipcRenderer.invoke('session:compaction', id),
    updateWorkspace: (id: string, workspacePath: string): Promise<boolean> =>
      ipcRenderer.invoke('session:updateWorkspace', id, workspacePath)
  },

  // ============================================================
  // 窗口控制（无边框自定义标题栏）
  // ============================================================
  window: {
    minimize: (): Promise<void> =>
      ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> =>
      ipcRenderer.invoke('window:toggle-maximize'),
    close: (): Promise<void> =>
      ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> =>
      ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (cb: (maximized: boolean) => void) => {
      const handler = (_e: any, maximized: boolean) => cb(maximized)
      ipcRenderer.on('window:maximized-change', handler)
      return () => { ipcRenderer.removeListener('window:maximized-change', handler) }
    }
  },

  // ============================================================
  // Agent 对话
  // ============================================================
  agent: {
    /** 发送消息并启动 agent 运行（立即返回；agent 在后台独立运行，多个会话可并行） */
    run: (sessionId: string, message: UserMessageInput, options?: { providerId?: string; modelOverride?: string; approveMode?: AutoApproveMode; reasoningEffort?: ReasoningEffort }): Promise<{ ok?: boolean; error?: string; userMessage?: UIMessage }> =>
      ipcRenderer.invoke('agent:run', sessionId, message, options),
    /** 查询正在运行的会话 ID 列表（用于启动时恢复侧边栏运行指示） */
    running: (): Promise<string[]> =>
      ipcRenderer.invoke('agent:running'),
    /** 中止某个会话的运行（不影响其他并行会话） */
    abort: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('agent:abort', sessionId),
    /** 动态切换批准模式（运行中即时生效） */
    setApproveMode: (sessionId: string, mode: AutoApproveMode): Promise<boolean> =>
      ipcRenderer.invoke('agent:set-approve-mode', sessionId, mode),
    /** 手动压缩当前会话上下文（早期消息合并为摘要，保留最近消息） */
    compactNow: (sessionId: string): Promise<{ ok?: boolean; error?: string; info?: { beforeTokens: number; afterTokens: number; compressedCount: number; keptCount: number } }> =>
      ipcRenderer.invoke('agent:compact-now', sessionId),
    /** 回复权限请求 */
    respondPermission: (permId: string, allowed: boolean): Promise<boolean> =>
      ipcRenderer.invoke('agent:permission_response', permId, allowed),

    // 事件监听
    onToken: (cb: (data: { sessionId: string; messageId: string; token: string }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:token', handler)
      return () => ipcRenderer.removeListener('agent:token', handler)
    },
    /** 模型思考内容增量（reasoning_content；仅 UI 展示，不混入正文） */
    onReasoning: (cb: (data: { sessionId: string; messageId: string; token: string }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:reasoning', handler)
      return () => ipcRenderer.removeListener('agent:reasoning', handler)
    },
    onUserMessage: (cb: (data: { sessionId: string; message: UIMessage }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:user_message', handler)
      return () => ipcRenderer.removeListener('agent:user_message', handler)
    },
    /**
     * assistant 消息事件（流式 token 会携带此 messageId，用于精确路由到对应消息）
     * phase='start'：本轮 LLM 开始输出（UI 把 thinking 占位替换为流式消息）
     * phase='end'：本轮结束已落库（UI 把流式消息收尾为 done；reasoning 为权威完整值）
     */
    onAssistantMessage: (cb: (data: { sessionId: string; messageId: string; content: string; toolCalls: any[]; phase: 'start' | 'end'; reasoning?: string }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:assistant_message', handler)
      return () => ipcRenderer.removeListener('agent:assistant_message', handler)
    },
    /** 某个会话被中止（用户按 Stop） */
    onAborted: (cb: (data: { sessionId: string }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:aborted', handler)
      return () => ipcRenderer.removeListener('agent:aborted', handler)
    },
    /** 运行状态变化（某会话开始/结束运行） */
    onRunningChange: (cb: (data: { sessionId: string; running: boolean }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:running', handler)
      return () => ipcRenderer.removeListener('agent:running', handler)
    },
    onToolCall: (cb: (data: { sessionId: string; messageId: string | null; toolCall: any }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:tool_call', handler)
      return () => ipcRenderer.removeListener('agent:tool_call', handler)
    },
    onToolResult: (cb: (data: { sessionId: string; messageId: string; toolCallId: string; toolName: string; result: string; isError: boolean; durationMs: number }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:tool_result', handler)
      return () => ipcRenderer.removeListener('agent:tool_result', handler)
    },
    onComplete: (cb: (data: { sessionId: string; messageId: string; content: string }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:complete', handler)
      return () => ipcRenderer.removeListener('agent:complete', handler)
    },
    onError: (cb: (data: { sessionId: string; error: string }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:error', handler)
      return () => ipcRenderer.removeListener('agent:error', handler)
    },
    onRetry: (cb: (data: { sessionId: string; failedAttempt: number; maxRetries: number }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:retry', handler)
      return () => ipcRenderer.removeListener('agent:retry', handler)
    },
    /** 单轮输出被 max_tokens 上限截断（kind: 'tool' = 工具调用被截断，'text' = 纯文本被截断） */
    onTruncated: (cb: (data: { sessionId: string; kind: 'tool' | 'text' }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:truncated', handler)
      return () => ipcRenderer.removeListener('agent:truncated', handler)
    },
    onPermissionRequest: (cb: (data: { sessionId: string; permId: string; toolName: string; args: any; level?: string }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:permission_request', handler)
      return () => ipcRenderer.removeListener('agent:permission_request', handler)
    },
    onPermissionResolved: (cb: (data: { sessionId: string; permId: string; resolution: 'approved' | 'denied' | 'cancelled' | 'timeout' }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:permission_resolved', handler)
      return () => ipcRenderer.removeListener('agent:permission_resolved', handler)
    },
    /** source=auto：运行中自动压缩（消息表不变）；source=manual：手动压缩。
     *  两者都不删除消息 —— boundaryMessageId 之前的历史在 LLM 上下文中被摘要折叠，
     *  前端据此渲染"历史已折叠"标记（完整历史始终可见）。 */
    onCompact: (cb: (data: { sessionId: string; source: 'auto' | 'manual'; boundaryMessageId?: string; beforeTokens: number; afterTokens: number; compressedCount: number; keptCount: number }) => void) => {
      const handler = (_e: any, data: any) => cb(data)
      ipcRenderer.on('agent:compact', handler)
      return () => ipcRenderer.removeListener('agent:compact', handler)
    }
  },

  // ============================================================
  // Settings
  // ============================================================
  settings: {
    get: (): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:get'),
    save: (settings: AppSettings): Promise<boolean> =>
      ipcRenderer.invoke('settings:save', settings),
    pickDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke('settings:pickDirectory'),
    pickFile: (): Promise<string | null> =>
      ipcRenderer.invoke('settings:pickFile'),
    openExternal: (url: string): Promise<boolean> =>
      ipcRenderer.invoke('shell:openExternal', url),
    /** 主进程侧设置被修改（如 agent 增删 MCP 服务器）→ 前端重新拉取 */
    onChanged: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('settings:changed', handler)
      return () => ipcRenderer.removeListener('settings:changed', handler)
    }
  },

  telegram: {
    test: (config: TelegramBotConfig): Promise<{ ok?: boolean; bot?: { name: string; username?: string }; error?: string }> =>
      ipcRenderer.invoke('telegram:test', config)
  },

  // ============================================================
  // MCP
  // ============================================================
  mcp: {
    connect: (config: any): Promise<{ ok?: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp:connect', config),
    disconnect: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('mcp:disconnect', id)
  },

  // ============================================================
  // Memory — longterm-skill
  // ============================================================
  memory: {
    list: (options?: { category?: string; search?: string; limit?: number }): Promise<any[]> =>
      ipcRenderer.invoke('memory:list', options),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('memory:delete', id),
    clearAll: (): Promise<boolean> =>
      ipcRenderer.invoke('memory:clearAll'),
    updateImportance: (id: string, importance: number): Promise<boolean> =>
      ipcRenderer.invoke('memory:updateImportance', id, importance)
  },

  // ============================================================
  // Token Usage（30 分钟桶）
  // ============================================================
  token: {
    summary: (): Promise<any[]> =>
      ipcRenderer.invoke('token:summary'),
    buckets: (days?: number): Promise<any[]> =>
      ipcRenderer.invoke('token:buckets', days)
  },

  // ============================================================
  // Provider 上下文窗口探测
  // ============================================================
  provider: {
    /** 探测上下文窗口（用户填/改 Base URL 时自动识别；返回检测到的 token 数） */
    detectContextWindow: (provider: any, modelOverride?: string): Promise<{ detected?: number; error?: string }> =>
      ipcRenderer.invoke('provider:context-window', provider, modelOverride),
    /** 拉取模型列表（OpenAI 兼容 GET /models；主进程缓存 5 分钟，force 强刷） */
    listModels: (provider: any, force?: boolean): Promise<{ models: { id: string; name?: string; ownedBy?: string }[]; error?: string }> =>
      ipcRenderer.invoke('provider:models', provider, force)
  },

  // ============================================================
  // 通用事件
  // ============================================================
  onLog: (cb: (data: { level: string; msg: string; ts: string }) => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('agent:log', handler)
    return () => ipcRenderer.removeListener('agent:log', handler)
  },
  onSessionTitleUpdated: (cb: (data: { sessionId: string; title: string }) => void) => {
    const handler = (_e: any, data: any) => cb(data)
    ipcRenderer.on('session:title_updated', handler)
    return () => ipcRenderer.removeListener('session:title_updated', handler)
  }
}

export type ZhumoraAPI = typeof api

// 使用 contextBridge 安全暴露
contextBridge.exposeInMainWorld('api', api)
