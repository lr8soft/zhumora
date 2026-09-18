// ============================================================
// MCP 入站服务器 — 传输层（loopback HTTP + Bearer token）。
// 实现 MCP streamable-http 协议的最小必要面（JSON-RPC over POST /mcp）：
// initialize / tools/list / tools/call / ping / notifications。
// 只负责：绑定 127.0.0.1、鉴权、会话头、JSON-RPC 路由、工具 schema。
// 会话与运行规则全部在 service.ts；本文件不 import runner/store/SessionService。
// ============================================================
import { randomUUID } from 'node:crypto'
import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServerSettings } from '../../shared/mcpServer.ts'
import { log } from '../llm/logger.ts'
import type { McpInboundService } from './service.ts'

export interface McpTransportHandle {
  start(): Promise<void>
  stop(): Promise<void>
  port(): number | null
  status(): 'stopped' | 'running' | 'error'
  error(): string | null
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const MAX_BODY_BYTES = 1024 * 1024
const MAX_WAIT_MS = 10 * 60 * 1000

const TOOLS: unknown[] = [
  {
    name: 'zhumora_chat',
    description: [
      'Send a delegated task or message to the Zhumora desktop agent. Zhumora runs a full',
      'agent session (files, shell, browser, Windows desktop control, Office documents) and',
      'returns its final reply. Use wait_ms to bound how long to block: when the task is',
      'still running after wait_ms the result has status "running" — poll zhumora_status',
      'with the same conversation instead of sending a duplicate message.',
      'While awaiting_permission, follow the guidance in the result: either the user in the',
      'Zhumora desktop UI will decide, or (when you are authorized to) call zhumora_respond.',
      'Keep one conversation per ongoing task by reusing the same MCP connection.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The task or message to delegate.' },
        wait_ms: {
          type: 'number',
          description: `Max time to wait for a terminal result, in ms (default 60000, max ${MAX_WAIT_MS}). 0 returns the current status immediately.`
        }
      },
      required: ['message']
    }
  },
  {
    name: 'zhumora_respond',
    description: [
      'Decide a pending Zhumora permission request on behalf of the user. Only usable when',
      'the request is marked decidable_by_you (Zhumora permission mode "delegate" and the',
      'tool is of normal risk level). Dangerous operations always require the human user in',
      'the Zhumora desktop UI — do not retry zhumora_respond for those; poll zhumora_status.',
      'Pass reason to record why you approved or denied (visible in Zhumora logs).'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        permission_id: { type: 'string' },
        allow: { type: 'boolean' },
        reason: { type: 'string', description: 'Short justification (recommended).' }
      },
      required: ['permission_id', 'allow']
    }
  },
  {
    name: 'zhumora_status',
    description: 'Get the current status of the Zhumora task for this conversation: running, awaiting_permission, completed, failed or aborted.'
  }
]

export function createMcpTransport(options: {
  service: McpInboundService
  getSettings: () => McpServerSettings
  /** 固定端口；0 = 自动分配（临时端口）。启动时读取一次。 */
  port: () => number
}): McpTransportHandle {
  let server: http.Server | null = null
  let startError: string | null = null
  // MCP 协议会话（Mcp-Session-Id）→ Zhumora 外部对话键。
  const mcpSessions = new Map<string, string>()

  const start = async (): Promise<void> => {
    startError = null
    const httpServer = http.createServer((req, res) => {
      void handleRequest(req, res).catch(error => {
        log('error', `MCP server request failed: ${safeError(error)}`)
        if (!res.headersSent) sendJson(res, 500, jsonRpcError(null, -32603, 'Internal server error.'))
      })
    })
    // tools/call 会阻塞到任务结束（最长 MAX_WAIT_MS + 运行时间），禁用请求级超时。
    httpServer.requestTimeout = 0
    httpServer.keepAliveTimeout = 65_000
    const requestedPort = options.port()
    const listener = (port: number): Promise<void> => new Promise((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, '127.0.0.1', () => {
        httpServer.removeListener('error', reject)
        resolve()
      })
    })
    try {
      if (requestedPort > 0) {
        try {
          await listener(requestedPort)
        } catch (error) {
          // 固定端口被占用：回退到临时端口，而不是让服务器起不来（URL 以 status 为准）。
          log('warn', `MCP server port ${requestedPort} is busy; falling back to an ephemeral port`)
          await listener(0)
        }
      } else {
        await listener(0)
      }
    } catch (error) {
      throw error
    }
    server = httpServer
    log('info', `MCP server listening on http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`)
  }

  const stop = async (): Promise<void> => {
    mcpSessions.clear()
    const current = server
    server = null
    if (!current) return
    await new Promise<void>(resolve => {
      current.closeAllConnections?.()
      current.close(() => resolve())
    })
  }

  const status = (): 'stopped' | 'running' | 'error' => (server ? 'running' : startError ? 'error' : 'stopped')

  return {
    start,
    stop,
    port: () => (server ? (server.address() as AddressInfo | null)?.port ?? null : null),
    status,
    error: () => startError
  }

  // ------------------------------------------------------------

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const settings = options.getSettings()
    if (!authorized(req, settings.token)) {
      sendJson(res, 401, { error: 'Invalid or missing Bearer token.' })
      return
    }
    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
      const body = await readBody(req)
      if (body === null) { sendJson(res, 413, { error: 'Request body too large.' }); return }
      let parsed: JsonRpcRequest | JsonRpcRequest[]
      try {
        parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[]
      } catch {
        sendJson(res, 400, jsonRpcError(null, -32700, 'Invalid JSON.'))
        return
      }
      const sessionHeader = header(req, 'mcp-session-id')
      if (Array.isArray(parsed)) {
        const results = await Promise.all(parsed.map(item => dispatch(item, sessionHeader)))
        const responses = results.filter((item): item is { body: unknown } => item !== null).map(item => item.body)
        // 批量请求里若含 initialize，用新生成的会话头回传。
        const session = results.map(item => item?.session).find(value => value) ?? sessionHeader
        sendJson(res, 200, responses, session)
        return
      }
      const response = await dispatch(parsed, sessionHeader)
      if (response === null) {
        res.writeHead(202, sessionHeader ? { 'Mcp-Session-Id': sessionHeader } : {})
        res.end()
        return
      }
      // initialize 的响应必须回带 Mcp-Session-Id，客户端后续请求依赖它关联会话。
      sendJson(res, 200, response.body, response.session ?? sessionHeader)
      return
    }
    if (req.method === 'GET') {
      // streamable-http 的 SSE 通知通道：Zhumora 不主动推送，明确返回 405 让客户端只用 POST。
      sendJson(res, 405, { error: 'POST only.' })
      return
    }
    sendJson(res, 404, { error: 'Not found.' })
  }

  interface DispatchResult {
    body: unknown
    /** initialize 生成的协议会话头；覆盖请求头回传给客户端。 */
    session?: string
  }

  async function dispatch(request: JsonRpcRequest, sessionHeader: string | undefined): Promise<DispatchResult | null> {
    const id = request.id ?? null
    const method = request.method || ''
    const params = request.params || {}
    try {
      switch (method) {
        case 'initialize': {
          const clientInfo = (params.clientInfo as { name?: string } | undefined)?.name
          const key = clientInfo?.trim() || 'default'
          const sessionId = sessionHeader || randomUUID()
          mcpSessions.set(sessionId, key)
          return {
            session: sessionId,
            body: {
              jsonrpc: '2.0',
              id,
              result: {
                protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : options.getSettings().protocolVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'zhumora', version: '0.4.4' },
                instructions: 'Zhumora is a desktop AI agent on this Windows machine. Delegate tasks via zhumora_chat; track them via zhumora_status; answer its permission prompts via zhumora_respond when permitted.'
              }
            }
          }
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null
        case 'ping':
          return { body: { jsonrpc: '2.0', id, result: {} } }
        case 'tools/list':
          return { body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } }
        case 'tools/call':
          return { body: { jsonrpc: '2.0', id, result: await handleToolCall(params, sessionHeader) } }
        default:
          return { body: jsonRpcError(id, -32601, `Method not found: ${method}`) }
      }
    } catch (error) {
      return { body: jsonRpcError(id, -32603, safeError(error)) }
    }
  }

  async function handleToolCall(
    params: Record<string, unknown>,
    sessionHeader: string | undefined
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    const name = typeof params.name === 'string' ? params.name : ''
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
    const key = mcpSessions.get(sessionHeader || '') || 'default'
    const service = options.service

    if (name === 'zhumora_chat') {
      const message = typeof args.message === 'string' ? args.message : ''
      const rawWait = typeof args.wait_ms === 'number' && Number.isFinite(args.wait_ms) ? args.wait_ms : 60_000
      const waitMs = Math.max(0, Math.min(rawWait, MAX_WAIT_MS))
      const status = await service.chat(key, message, waitMs)
      return toToolResult(status)
    }
    if (name === 'zhumora_respond') {
      const permissionId = typeof args.permission_id === 'string' ? args.permission_id : ''
      const allow = args.allow === true
      const reason = typeof args.reason === 'string' ? args.reason : undefined
      if (!permissionId || (args.allow !== true && args.allow !== false)) {
        return toToolResult({ status: 'failed', error: 'permission_id (string) and allow (boolean) are required.' })
      }
      return toToolResult(service.respond(key, permissionId, allow, reason))
    }
    if (name === 'zhumora_status') {
      return toToolResult(service.status(key))
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }

  function toToolResult(status: Awaited<ReturnType<McpInboundService['status']>>): { content: { type: 'text'; text: string }[]; isError?: boolean } {
    const settings = options.getSettings()
    const payload =
      status.status === 'awaiting_permission'
        ? {
            ...status,
            guidance: status.permission.level === 'normal' && settings.permissionMode === 'delegate'
              ? 'You may call zhumora_respond (permission_id, allow, reason) to decide this request on the user\'s behalf, within the authority the user gave you.'
              : 'This decision requires the human user in the Zhumora desktop UI. Poll zhumora_status until the status changes.'
          }
        : status
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: status.status === 'failed' ? true : undefined
    }
  }
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  if (!token) return false
  const headerValue = req.headers['authorization'] || ''
  const match = /^Bearer\s+(.+)$/i.exec(headerValue)
  if (!match) return false
  const provided = Buffer.from(match[1])
  const expected = Buffer.from(token)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise(resolve => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

function sendJson(res: http.ServerResponse, code: number, body: unknown, sessionHeader?: string): void {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...(sessionHeader ? { 'Mcp-Session-Id': sessionHeader } : {})
  })
  res.end(payload)
}

function jsonRpcError(id: string | number | null, code: number, message: string): JsonRpcRequest & { error: { code: number; message: string } } {
  return { jsonrpc: '2.0', id, error: { code, message } } as never
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}
