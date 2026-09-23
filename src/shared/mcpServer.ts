import type { AutoApproveMode, McpServerInboundConfig } from './types'

/**
 * 对外 MCP 服务器（Zhumora 作为 MCP Server 被外部编排器接入）归一化。
 * 类型是 McpServerInboundConfig（shared/types.ts）；连接生命周期归 main 进程
 * 适配器（src/main/mcpServer/），本文件只放纯函数与默认值。
 * 注意：本文件会被打进 renderer bundle，禁止引入 node 内置模块
 * （token 生成用 globalThis.crypto，main/renderer/node 测试三处通用）。
 */
export type McpServerSettings = McpServerInboundConfig

/**
 * 生成对外 MCP 服务器 token：24 字节 base64url（32 字符）。
 * 与历史值同规格，保证新旧 token 在客户端配置里形状一致。
 */
export function generateMcpServerToken(): string {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * token 稳定性规则（存储边界 normalizeSettings 调用，唯一自动生成点）：
 * 启用且无 token 时生成一个**固定值**，随 settings 落库。token 永不随应用
 * 重启自动轮换——轮换会让外部客户端（Codex 等）已粘贴的配置集体 401。
 * 只有用户显式重生成才换值（旧 token 立即失效）。
 * 纯函数：禁用态或非空 token 原样返回（同一引用）。
 */
export function ensureMcpServerToken(settings: McpServerInboundConfig): McpServerInboundConfig {
  if (!settings.enabled || settings.token) return settings
  return { ...settings, token: generateMcpServerToken() }
}

/**
 * 委托契约的措辞来源：MCP initialize `instructions` 的正文。
 * 多数 host 不会把 instructions 可靠注入模型上下文（opencode 无此通道，Codex
 * 旧版不读、且从不消费 prompts），对它们真正被看见的文字是 tools/list 的
 * name+description——所以委托意愿文案（同机能力、典型任务示例、负范围声明）
 * 必须同时写进 zhumora_chat 的描述（protocol.ts），本数组与描述各自维护、
 * 由单测同时锁住两者。
 */
const DELEGATION_IDENTITY = [
  'Zhumora is a capable subagent running as a desktop app on this Windows machine — shell, file system, browser automation, Windows GUI control, and Office documents — not a documentation or data lookup tool.',
  'Zhumora runs on the same machine as you, so it can read, write, and execute against the very same files and apps you can — and on top of that it controls the desktop GUI and the user\'s own browser. When the next step of the task needs any of those, delegate that step instead of guessing from the sandbox or asking the user to run it themselves.',
  'Delegate to Zhumora proactively when the work needs the real machine instead of the orchestrator\'s own sandbox: GUI or installed applications, files outside the working directory, the user\'s own browser profile, long unattended execution, or Office/document deliverables.',
  'Typical delegated tasks: open a settings dialog in an installed Windows app and change a value, inspect or operate the user\'s own browser session, run a build or a long script unattended, produce a .docx/.xlsx/.pptx/.pdf deliverable, or read and edit files outside your working directory.',
  'Do not delegate pure software tasks that stay inside your own sandbox: documentation lookups, general code questions, or edits to files already in your working directory — handle those yourself.',
  'The user installed and enabled Zhumora deliberately: treat it as a first-class capability for this session and do not pre-emptively re-implement that work yourself.'
]

const DELEGATION_PROTOCOL = [
  'Call zhumora_chat exactly once per task, with the deliverable and constraints spelled out, and keep the same MCP session for the whole lifecycle.',
  'A nonterminal result is not completion: if zhumora_chat returns running or awaiting_permission, call zhumora_wait with the returned task_id and cursor.',
  'zhumora_wait is the completion callback: leave one call pending until completed, failed, aborted, or awaiting_permission, while bounded progress notifications stream live activity.',
  'On awaiting_permission, call zhumora_respond to approve or deny whenever decidable_by_you=true — when in doubt, approve so the task keeps moving; otherwise ask the human to decide in the Zhumora window and then call zhumora_wait again.',
  'Never resend the task and never timer-poll zhumora_status; use zhumora_status only for an explicit instantaneous diagnostic snapshot.',
  'Do not claim success before a terminal result. Deliver Zhumora\'s reply and preserve its stated caveats.'
]

/** initialize `instructions` 正文（MCP 客户端能看见时的模型上下文）。 */
export const SERVER_INSTRUCTIONS = [...DELEGATION_IDENTITY, ...DELEGATION_PROTOCOL].join(' ')

/** 外部会话的来源提示：告诉 Zhumora agent 消息来自哪个编排器，而不是把对方当人。 */
export const MCP_SOURCE_PROMPT = [
  'Incoming messages are delegated tasks from an external orchestrator (a separate coding agent), not from a human user in this window.',
  'You do not have a human to ask: state your assumptions in the reply when scope is ambiguous.',
  'Your final reply is the deliverable handed back to the orchestrator: make it self-contained, concrete, and concise. Plain text or Markdown only.',
  'When a tool permission is denied, treat it as a hard constraint and work within it instead of retrying the same call.'
].join('\n')

export const DEFAULT_MCP_SERVER_SETTINGS: McpServerInboundConfig = {
  enabled: false,
  token: '',
  clientLabel: 'MCP',
  permissionMode: 'ui',
  approveMode: 'manual',
  port: 0
}

const LABEL_RE = /^[\p{L}\p{N}._ -]+$/u

export function normalizeMcpServerSettings(input: unknown): McpServerInboundConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_MCP_SERVER_SETTINGS }
  const raw = input as Partial<McpServerInboundConfig>
  const label = typeof raw.clientLabel === 'string' ? raw.clientLabel.trim().slice(0, 32) : ''
  return {
    enabled: raw.enabled === true,
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    clientLabel: label && LABEL_RE.test(label) ? label : 'MCP',
    permissionMode: raw.permissionMode === 'delegate' ? 'delegate' : 'ui',
    approveMode: raw.approveMode === 'auto' || raw.approveMode === 'full' ? raw.approveMode : 'manual',
    port: typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port >= 0 && raw.port <= 65535
      ? raw.port
      : DEFAULT_MCP_SERVER_SETTINGS.port
  }
}

/** 语义比较：字段逐一比较；token 变化必须触发重启（旧 token 立即失效）。 */
export function equivalentMcpServerSettings(left: McpServerInboundConfig, right: McpServerInboundConfig): boolean {
  const a = normalizeMcpServerSettings(left)
  const b = normalizeMcpServerSettings(right)
  return a.enabled === b.enabled
    && a.token === b.token
    && a.clientLabel === b.clientLabel
    && a.permissionMode === b.permissionMode
    && a.approveMode === b.approveMode
    && a.port === b.port
}
