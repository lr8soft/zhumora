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
  /** 思考强度功能开关：开启后聊天输入框显示"思考强度"下拉，用户按会话选择。
   *  关闭时不发送 reasoning_effort 参数 */
  reasoningEnabled?: boolean
  /** @deprecated 已迁移到对话级选择（ReasoningEffort），保留字段仅为旧数据兼容，不再读取 */
  reasoningEffort?: 'low' | 'medium' | 'high'
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
  /** 模型思考内容（reasoning_content，如 DeepSeek-R1 / o-series）。DB 单独列持久化，
   *  重建 LLM 历史时不混入 content、不回传给模型（与 Cline / opencode 做法一致） */
  reasoning?: string
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

/** 工具返回给模型的附件。二进制内容保持结构化，禁止嵌入魔法字符串。 */
export interface ToolImageAttachment {
  type: 'image'
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  base64: string
  detail?: 'auto' | 'low' | 'high'
}

export type ToolAttachment = ToolImageAttachment

/**
 * 工具 handler 的标准输出。
 * content 用于持久化和 UI；attachments 只进入本轮 LLM 多模态上下文。
 */
export interface ToolExecutionResult {
  content: string
  attachments?: ToolAttachment[]
  /** 预期内的工具失败（例如远端 MCP 返回 isError），无需通过 throw 编码。 */
  isError?: boolean
}

/**
 * 兼容尚未迁移的纯文本工具。新增工具必须返回 ToolExecutionResult；
 * registry 边界会把旧 string 输出归一化，runner 只处理标准结构。
 */
export type ToolHandlerOutput = ToolExecutionResult | string

/** 已完成的一次工具调用（跨进程/观测层使用） */
export interface ToolResult extends ToolExecutionResult {
  id: string                       // 关联的 tool_call_id
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

/** Telegram Bot API（HTTPS long polling）配置。 */
export interface TelegramBotConfig {
  enabled: boolean
  /** BotFather 签发的 token；仅在 main 进程用于请求 Telegram。 */
  token: string
  /** 允许触发 Agent 的 Telegram User ID；空列表时仅响应 /id。 */
  allowedUserIds: string[]
  /** Telegram 会话默认使用的三档工具批准模式。 */
  approveMode: AutoApproveMode
}

/** QQ 开放平台 Bot（WebSocket Gateway + OpenAPI）配置。 */
export interface QQBotConfig {
  enabled: boolean
  /** QQ 开放平台签发的应用 ID。 */
  appId: string
  /** QQ 开放平台签发的应用密钥；仅在 main 进程交给官方 SDK。 */
  appSecret: string
  /** 允许触发 Agent 的用户 OpenID；空列表时仅响应 /id。 */
  allowedUserIds: string[]
  /** QQ 会话默认使用的三档工具批准模式。 */
  approveMode: AutoApproveMode
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

/** 对话级思考强度（聊天输入框选择，每次 agent 运行携带）
 *  - off:    不发送 reasoning_effort 参数（模型默认行为）
 *  - low:    快速，少思考
 *  - medium: 平衡
 *  - high:   深度推理
 */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high'

/** 工具调用批准模式（三档）
 * - manual: 手动批准 — safe 放行，normal + dangerous 都弹窗
 * - auto:   自动批准 — safe + normal 放行，dangerous 弹窗
 * - full:   全自动批准 — 日常工具放行；alwaysConfirm 能力边界变更仍需确认
 */
export type AutoApproveMode = 'manual' | 'auto' | 'full'

/** 设置 */
export interface AppSettings {
  /** settings JSON 的结构版本；由存储层迁移，调用方不自行修改 */
  schemaVersion?: number
  providers: ProviderConfig[]
  mcpServers: McpServerConfig[]
  telegramBot: TelegramBotConfig
  qqBot: QQBotConfig
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
  /**
   * 浏览器模式（默认 'local'）：
   * - local:    调用本机安装的 Chrome，显示窗口，使用专用持久化 profile
   *             （cookies/登录态跨会话保留，人工过一次验证码后长期有效；
   *             未安装 Chrome 时自动回退内置 Chromium 的可视模式）。
   * - headless: 内置 Chromium 后台无头运行（同样用持久化 profile + 反检测注入）。
   * 浏览器已在运行时切换该设置，下次 ensureBrowser 会重启浏览器以生效。
   */
  browserMode?: 'local' | 'headless'
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
