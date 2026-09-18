import type { AutoApproveMode, McpServerInboundConfig } from './types'

/**
 * 对外 MCP 服务器（Zhumora 作为 MCP Server 被外部编排器接入）归一化。
 * 类型是 McpServerInboundConfig（shared/types.ts）；连接生命周期归 main 进程
 * 适配器（src/main/mcpServer/），本文件只放纯函数与默认值。
 */
export type McpServerSettings = McpServerInboundConfig

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
