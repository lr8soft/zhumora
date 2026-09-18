// ============================================================
// MCP 入站服务器 — 连接生命周期（组合根调用）。
// 对应 mcp/client.ts（出站）的入站版本：
//   configure 按归一化后的设置启动/停止 loopback HTTP 传输；
//   设置等价（equivalent）则不动，token 变化触发重启使旧 token 立即失效。
// 不持有会话/运行状态：编排规则在 service.ts，传输在 transport.ts。
// ============================================================
import { randomBytes } from 'node:crypto'
import { log } from '../llm/logger.ts'
import {
  equivalentMcpServerSettings,
  normalizeMcpServerSettings,
  type McpServerSettings
} from '../../shared/mcpServer.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { BotSessionAdapter } from '../bot/sessionAdapter.ts'
import type { SessionService } from '../agent/sessionService.ts'
import type { PermissionBroker } from '../agent/permissionBroker.ts'
import { McpInboundService } from './service.ts'
import { createMcpTransport, type McpTransportHandle } from './transport.ts'

export type McpServerState = 'stopped' | 'connecting' | 'connected' | 'failed'

export interface McpServerStatus {
  state: McpServerState
  url: string | null
  /** 生效的 Bearer token（含自动生成的值）。loopback 专用，供设置页拼接入命令；不进日志。 */
  token: string | null
  error: string | null
}

export class McpServerManager {
  private service: McpInboundService
  private transport: McpTransportHandle | null = null
  private settings: McpServerSettings
  /** 生效 token（设置值或自动生成的值）。与 effective 设置同源，是鉴权与 status 回显的唯一事实源。 */
  private effectiveToken: string | null = null
  private state: McpServerState = 'stopped'
  private stateError: string | null = null

  constructor(
    sessions: SessionService,
    botSessions: BotSessionAdapter,
    permissions: PermissionBroker,
    registry: ToolRegistry,
    initialSettings: McpServerSettings
  ) {
    this.settings = normalizeMcpServerSettings(initialSettings)
    this.service = new McpInboundService(botSessions, sessions, permissions, registry, this.settings)
  }

  status(): McpServerStatus {
    const port = this.transport?.port()
    return {
      state: this.state,
      url: this.state === 'connected' && port ? `http://127.0.0.1:${port}/mcp` : null,
      // 仅在运行中回显：stopped 时 token 已作废，回显会误导客户端配置。
      token: this.state === 'connected' ? this.effectiveToken : null,
      error: this.stateError
    }
  }

  /** 设置保存后的增量应用：等价（或从禁用态切到禁用态）时不产生重启。 */
  async applySettings(next: { mcpServer: McpServerSettings }, previous: { mcpServer: McpServerSettings }): Promise<void> {
    if (equivalentMcpServerSettings(next.mcpServer, previous.mcpServer)) return
    await this.configure(next.mcpServer)
  }

  /** 按当前设置同步服务器生命周期（幂等；等价设置不产生重启）。 */
  async configure(settings: McpServerSettings): Promise<void> {
    const normalized = normalizeMcpServerSettings(settings)
    if (equivalentMcpServerSettings(normalized, this.settings) && this.state !== 'failed') {
      this.service.updateSettings(normalized)
      return
    }
    this.settings = normalized
    this.service.updateSettings(normalized)
    if (!normalized.enabled) {
      await this.stopTransport()
      this.setState('stopped')
      return
    }
    await this.stopTransport()
    const token = normalized.token || randomBytes(24).toString('base64url')
    // token 为空（自动生成）时不回写 settings 表：值只存在于运行中的传输层，
    // 重启应用会生成新 token，避免把未保存的密钥写进用户配置。
    this.effectiveToken = token
    const effective = { ...normalized, token }
    this.service.updateSettings(effective)
    const transport = createMcpTransport({
      service: this.service,
      // 鉴权只信 effectiveToken：设置里的 token 与生效值恒等（手动值直接采用，
      // 空值采用自动生成的值），无需在两个来源间切换。
      getSettings: () => ({ ...this.settings, token: this.effectiveToken ?? '' }),
      port: () => effective.port
    })
    this.state = 'connecting'
    this.stateError = null
    try {
      await transport.start()
    } catch (error) {
      this.transport = null
      this.setState('failed', error)
      throw error
    }
    this.transport = transport
    this.setState('connected')
  }

  async stop(): Promise<void> {
    await this.service.stop()
    await this.stopTransport()
    this.effectiveToken = null
    this.setState('stopped')
  }

  private async stopTransport(): Promise<void> {
    const transport = this.transport
    this.transport = null
    if (!transport) return
    try {
      await transport.stop()
    } catch (error) {
      log('warn', `MCP server transport stop failed: ${safeError(error)}`)
    }
  }

  private setState(state: McpServerState, error?: unknown): void {
    this.state = state
    this.stateError = error ? safeError(error) : null
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}
