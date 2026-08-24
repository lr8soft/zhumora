// ============================================================
// Shared types — 主进程 & 渲染进程共用契约
// ============================================================

/** LLM 角色标记 */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

/** OpenAI 多模态 content part */
export interface ContentPartText {
  type: 'text'
  text: string
}
export interface ContentPartImageUrl {
  type: 'image_url'
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
}
export type ContentPart = ContentPartText | ContentPartImageUrl

/** 单条对话消息（OpenAI 格式扩展） */
export interface ChatMessage {
  role: Role
  content: string | null | ContentPart[]
  tool_calls?: ToolCall[]
  tool_call_id?: string          // role=tool 时关联的调用 ID
  name?: string                  // role=tool 时工具名
}

/** LLM 发起的工具调用 */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }  // arguments 是 JSON 字符串
}

/** Provider 配置 */
export interface ProviderConfig {
  id: string
  name: string                     // 用户起的名字
  baseUrl: string                  // OpenAI 兼容端点，如 https://api.openai.com/v1
  apiKey: string
  defaultModel: string
  enabled: boolean
  temperature?: number             // 采样温度，不设则由 API 默认
  reasoningEnabled?: boolean       // 是否启用思考强度
  reasoningEffort?: 'low' | 'medium' | 'high'  // 思考强度（reasoning_effort）
  contextWindow?: number           // 模型上下文窗口大小（token 数），0 或未设 = 自动检测
}

/** 单条渲染消息（UI 专用，含元数据） */
export interface UIMessage {
  id: string
  sessionId: string
  role: Role
  content: string
  /** 用户消息携带的图片（base64 data URL，如 "data:image/png;base64,..."）。仅 user 消息使用，DB 单独列持久化 */
  images?: string[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  timestamp: number
  status?: 'pending' | 'streaming' | 'done' | 'error' | 'thinking'
}

/**
 * 上下文压缩摘要消息的固定前缀（以 user 角色存库）。
 * 渲染时据此识别并展示为可折叠的摘要块（而非普通用户气泡）。
 */
export const COMPACT_SUMMARY_PREFIX = '[Auto Compact Summary]'

/** 渲染进程发起用户消息的输入（文本 + 可选图片附件） */
export interface UserMessageInput {
  text: string
  images?: string[]
}

/** 会话 */
export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  workspacePath?: string
}

/** 工具描述（供 LLM function-calling） */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: object             // JSON Schema
  }
}

/** 工具执行结果 */
export interface ToolResult {
  id: string                       // 关联的 tool_call_id
  content: string
  isError: boolean
  durationMs: number
}

/** MCP Server 配置 */
export interface McpServerConfig {
  id: string
  name: string
  type: 'stdio' | 'sse' | 'streamable-http'
  command?: string                 // stdio 模式
  args?: string[]
  env?: Record<string, string>
  url?: string                     // sse 模式
  headers?: Record<string, string> // sse 模式自定义 headers
  /** SSE 认证类型快捷配置 */
  authType?: 'none' | 'bearer' | 'apikey' | 'custom'
  /** Bearer Token（authType=bearer 时使用） */
  authToken?: string
  /** API Key（authType=apikey 时使用，发送到 authHeader 指定的 header） */
  apiKey?: string
  /** API Key 使用的 header 名称（默认 X-API-Key） */
  authHeader?: string
  enabled: boolean
}

/** Skill 配置 */
export interface SkillConfig {
  id: string
  name: string
  path: string                     // SKILL.md 路径
  enabled: boolean
}

/**
 * 用户主动中止（Stop）时由 Agent runner 抛出。
 * provider 层对"用户中止"按部分内容正常完成处理（不抛错、不重试），
 * 因此 runner 在每轮之间显式检查 signal 并抛出本错误，
 * 让 IPC 层把该会话标记为已停止并通知前端（避免状态卡死）。
 */
export class AgentAbortedError extends Error {
  constructor() {
    super('Aborted')
    this.name = 'AgentAbortedError'
  }
}

/** 工具调用批准模式（三档）
 * - manual: 手动批准 — safe 放行，normal + dangerous 都弹窗
 * - auto:   自动批准 — safe + normal 放行，dangerous 弹窗
 * - full:   全自动批准 — 全部放行，不弹窗
 */
export type AutoApproveMode = 'manual' | 'auto' | 'full'

/** 设置 */
export interface AppSettings {
  providers: ProviderConfig[]
  mcpServers: McpServerConfig[]
  skills: SkillConfig[]
  activeProviderId: string | null
  workspacePath: string
  /** 长期记忆功能开关 */
  memoryEnabled?: boolean
  /** 界面语言 ('auto' 时跟随系统) */
  language?: string
  /** LLM/MCP 网络请求失败的最大重试次数（-1 = 无限重试，0 = 不重试，默认 5） */
  maxRetries?: number
  /** 单次对话最大工具轮数（0 = 不限制，默认 20）。达到后强制停止并生成纯文本收尾总结 */
  maxRounds?: number
  /**
   * 使用操作系统证书库（默认 false）。
   * 开启后所有出网请求（LLM / MCP / 上下文探测）走 Electron net.fetch（Chromium 网络栈，
   * 信任 Windows 系统证书库，与 Chrome 一致），自签名证书 / 内网 CA 的端点即可正常连接。
   * 关闭时走 Node 内置 fetch（打包的 Mozilla CA，不读系统证书库）。
   */
  useSystemCerts?: boolean
}

// ============================================================
// 长期记忆 — longterm-skill
// ============================================================

/** 记忆类别 */
export type MemoryCategory = 'preference' | 'habit' | 'fact' | 'skill' | 'context'

/** 记忆条目 */
export interface MemoryEntry {
  id: string
  category: MemoryCategory
  content: string
  importance: number               // 1-5，5 最重要
  sourceSessionId: string | null   // 来源会话
  createdAt: number
  lastAccessed: number
  accessCount: number
  tags: string[]                    // 关键词标签，用于检索
}
