// ============================================================
// MCP Client — 基于官方 @modelcontextprotocol/sdk
// 支持 stdio + SSE 两种传输方式
// ============================================================
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, ToolDefinition } from '../../shared/types'
import { registerTool, unregisterToolsBySource, type ToolHandler, type ToolContext } from '../tools/registry'
import { log } from '../llm/logger'
import { getMaxRetries, withRetry } from '../net/retry'
import { getMcpFetch } from '../net/fetch'

interface ActiveConnection {
  client: Client
  config: McpServerConfig
}

/** 单个 MCP 服务器的连接状态 */
export type McpConnectionState = 'connecting' | 'connected' | 'failed'

interface ServerState {
  id: string
  name: string
  state: McpConnectionState
  error?: string
}

const connections = new Map<string, ActiveConnection>()

/** 所有已配置的 MCP 服务器状态（含连接中/已连接/失败） */
const serverStates = new Map<string, ServerState>()

/**
 * 获取所有已配置 MCP 服务器的当前连接状态
 * 供 runner 构建 system prompt 时使用：已连接的列工具，没连上的告诉 AI 不可用
 */
export function getMcpConnectionStatus(): { id: string; name: string; connected: boolean }[] {
  return Array.from(serverStates.values()).map(s => ({
    id: s.id,
    name: s.name,
    connected: s.state === 'connected'
  }))
}

/**
 * 根据 config 构建 SSE 请求 headers
 * 合并自定义 headers + 认证 headers（认证优先级更高）
 */
function buildSseHeaders(config: McpServerConfig): Record<string, string> {
  const headers: Record<string, string> = {}

  // 1. 先合并用户自定义 headers
  if (config.headers) {
    Object.assign(headers, config.headers)
  }

  // 2. 根据认证类型添加认证 header（覆盖同名自定义 header）
  switch (config.authType) {
    case 'bearer':
      if (config.authToken) {
        headers['Authorization'] = `Bearer ${config.authToken}`
      }
      break
    case 'apikey':
      if (config.apiKey) {
        const headerName = config.authHeader || 'X-API-Key'
        headers[headerName] = config.apiKey
      }
      break
    case 'custom':
      // 用户通过 headers 字段自行配置，不做额外处理
      break
    case 'none':
    default:
      break
  }

  return headers
}

/**
 * 连接一个 MCP Server，注册其所有工具
 */
export async function connectMcpServer(config: McpServerConfig): Promise<void> {
  if (!config.enabled) {
    log('info', `MCP server "${config.name}" is disabled, skipping`)
    return
  }

  // 如果已存在先断开
  await disconnectMcpServer(config.id)

  // 标记为连接中
  serverStates.set(config.id, { id: config.id, name: config.name, state: 'connecting' })

  try {
    // ---- 解析 command/args ----
    let cmd = config.command!
    let cmdArgs = config.args || []

    // 如果 command 含空格且没有单独的 args，自动拆分
    if (!cmdArgs.length && cmd.includes(' ')) {
      const parts = cmd.split(/\s+/)
      cmd = parts[0]
      cmdArgs = parts.slice(1)
    }

    // Windows: npx/npm 等 .cmd 脚本需要通过 cmd /c 调用
    if (process.platform === 'win32') {
      if (cmd === 'npx' || cmd === 'npm' || cmd === 'node' || cmd.endsWith('.cmd')) {
        cmdArgs = ['/c', cmd, ...cmdArgs]
        cmd = 'cmd'
      }
    }

    // 网络失败自动重试（设置可配，支持无限）
    // 每次尝试都新建 transport：SSE/HTTP transport 是一次性的，stdio 需重新拉起子进程
    const maxRetries = getMaxRetries()
    const connected = await withRetry(
      async () => {
        const transport = config.type === 'stdio'
          ? new StdioClientTransport({
              command: cmd,
              args: cmdArgs,
              env: { ...process.env, ...(config.env || {}) } as Record<string, string>
            })
          : config.type === 'streamable-http'
          ? new StreamableHTTPClientTransport(new URL(config.url!), {
              requestInit: {
                headers: buildSseHeaders(config)
              },
              // 统一出口：开关开启时走 Electron net.fetch（系统证书库），兼容自签证书
              fetch: getMcpFetch()
            })
          : new SSEClientTransport(new URL(config.url!), {
              requestInit: {
                headers: buildSseHeaders(config)
              },
              // 同上；SSE 的 EventSource 内部 fetch 也以此为准
              fetch: getMcpFetch()
            })

        const client = new Client(
          { name: 'zhumora', version: '0.1.0' },
          { capabilities: {} }
        )
        try {
          await client.connect(transport)
        } catch (err) {
          // 清理失败连接，避免子进程/套接字泄漏
          try { await client.close() } catch { /* ignore */ }
          throw err
        }
        return { client, toolsList: await client.listTools() }
      },
      { maxRetries, label: `MCP connect "${config.name}"` }
    )

    connections.set(config.id, { client: connected.client, config })

    // 发现工具
    const client = connected.client
    const toolsList = connected.toolsList
    const sourceTag = `mcp:${config.id}`
    unregisterToolsBySource(sourceTag)

    for (const tool of toolsList.tools) {
      const handler: ToolHandler = {
        definition: {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || `MCP tool from ${config.name}`,
            parameters: tool.inputSchema || { type: 'object', properties: {} }
          }
        },
        // MCP 工具默认 normal 权限（manual 模式弹窗确认；auto/full 模式自动放行）
        permission: 'normal',
        async execute(args: Record<string, unknown>, ctx: ToolContext) {
          try {
            // SDK 1.30 的 callTool 返回类型是联合（常规结果 | task 结果），这里按常规结果处理
            const result = (await client.callTool({ name: tool.name, arguments: args })) as CallToolResult
            const text = result.content
              ?.map(c => (c.type === 'text' ? c.text : JSON.stringify(c)))
              .join('\n') || '(no output)'
            return text
          } catch (err) {
            return `MCP tool error: ${(err as Error).message}`
          }
        }
      }
      registerTool(tool.name, handler, sourceTag)
    }

    // 标记为已连接
    serverStates.set(config.id, { id: config.id, name: config.name, state: 'connected' })
    log('info', `MCP "${config.name}" connected, ${toolsList.tools.length} tools registered`)
  } catch (err) {
    // 标记为失败
    const errMsg = (err as Error).message
    serverStates.set(config.id, { id: config.id, name: config.name, state: 'failed', error: errMsg })
    log('error', `Failed to connect MCP "${config.name}": ${errMsg}`)
    throw err
  }
}

/**
 * 断开某个 MCP Server
 */
export async function disconnectMcpServer(id: string): Promise<void> {
  const conn = connections.get(id)
  if (conn) {
    try {
      await conn.client.close()
    } catch (err) {
      log('warn', `Error closing MCP "${conn.config.name}": ${(err as Error).message}`)
    }
  }
  unregisterToolsBySource(`mcp:${id}`)
  connections.delete(id)
  serverStates.delete(id)
  if (conn) {
    log('info', `MCP "${conn.config.name}" disconnected`)
  }
}

/**
 * 重连所有配置中的 MCP Servers
 * 非阻塞：有多少连上就用多少，连不上的标记为 failed
 */
export async function reconnectAllMcpServers(configs: McpServerConfig[]): Promise<void> {
  // 清理旧的 serverStates（保留正在重连的）
  const oldStates = new Map(serverStates)
  serverStates.clear()

  for (const config of configs) {
    if (!config.enabled) continue
    // 标记为连接中
    serverStates.set(config.id, { id: config.id, name: config.name, state: 'connecting' })
  }

  // 并行连接所有服务器，互不阻塞
  const results = await Promise.allSettled(
    configs.filter(c => c.enabled).map(c => connectMcpServer(c))
  )

  // 检查结果（connectMcpServer 内部已设置 state，这里只处理漏网之鱼）
  for (let i = 0; i < results.length; i++) {
    const config = configs.filter(c => c.enabled)[i]
    const result = results[i]
    if (result.status === 'rejected' && !serverStates.has(config.id)) {
      serverStates.set(config.id, {
        id: config.id,
        name: config.name,
        state: 'failed',
        error: result.reason?.message || 'Unknown error'
      })
    }
  }
}

/**
 * 获取所有活跃连接状态
 */
export function getMcpStatus(): { id: string; name: string; connected: boolean }[] {
  return Array.from(connections.values()).map(c => ({
    id: c.config.id,
    name: c.config.name,
    connected: true
  }))
}
