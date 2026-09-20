// ============================================================
// MCP 入站服务器 — loopback HTTP + Bearer token 传输层。
// Streamable HTTP、JSON-RPC、协议协商与 session 生命周期全部交给官方 SDK；
// 本文件只负责 HTTP 边界、鉴权、按 session 路由和 Zhumora 工具适配。
// 会话与 Agent 运行规则仍全部在 service.ts / SessionService。
// ============================================================
import { randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerSettings } from '../../shared/mcpServer.ts'
import { log } from '../llm/logger.ts'
import type { McpInboundService } from './service.ts'
import { createMcpProtocolServer } from './protocol.ts'

export interface McpTransportHandle {
  start(): Promise<void>
  stop(): Promise<void>
  port(): number | null
  status(): 'stopped' | 'running' | 'error'
  error(): string | null
}

interface ProtocolSession {
  transport: StreamableHTTPServerTransport
  server: McpServer
}

const MAX_BODY_BYTES = 1024 * 1024
export function createMcpTransport(options: {
  service: McpInboundService
  getSettings: () => McpServerSettings
  /** 固定端口；0 = 自动分配（临时端口）。启动时读取一次。 */
  port: () => number
}): McpTransportHandle {
  let httpServer: http.Server | null = null
  let startError: string | null = null
  let stopping = false
  const sessions = new Map<string, ProtocolSession>()

  const start = async (): Promise<void> => {
    startError = null
    stopping = false
    const candidate = http.createServer((req, res) => {
      void handleRequest(req, res).catch(error => {
        log('error', `MCP server request failed: ${safeError(error)}`)
        if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal server error.')
      })
    })
    // A tool call can wait for a delegated task for up to MAX_WAIT_MS.
    candidate.requestTimeout = 0
    candidate.keepAliveTimeout = 65_000
    try {
      await listen(candidate, options.port())
    } catch (error) {
      startError = safeError(error)
      candidate.close()
      throw error
    }
    httpServer = candidate
    log('info', `MCP server listening on http://127.0.0.1:${(candidate.address() as AddressInfo).port}/mcp`)
  }

  const stop = async (): Promise<void> => {
    stopping = true
    // 必须先关协议会话再关 HTTP server：streamable-http 客户端（Codex/Claude Code）
    // initialize 后会长期持有 GET SSE 流，那是 active socket，closeIdleConnections
    // 不碰它、httpServer.close() 会一直等它结束；而结束它的 server.close() 会级联
    // 清理 SDK 里的全部 SSE 流。顺序反了就是死锁——token/端口变更触发的重启
    // 永远停在旧服务器上，新 token 不生效，外部客户端持续 401。
    const active = [...sessions.values()]
    sessions.clear()
    await Promise.allSettled(active.map(session => session.server.close()))
    const current = httpServer
    httpServer = null
    if (!current) return
    current.closeIdleConnections?.()
    await new Promise<void>((resolve, reject) => {
      // 兜底：个别未受管的挂起连接（半开 TCP、异常挂起的请求体）也会卡住
      // close 回调，1.5s 后强杀全部连接，保证 stop 有界。
      const force = setTimeout(() => current.closeAllConnections?.(), 1500)
      current.close(error => {
        clearTimeout(force)
        if (error) reject(error)
        else resolve()
      })
    })
  }

  return {
    start,
    stop,
    port: () => (httpServer ? (httpServer.address() as AddressInfo | null)?.port ?? null : null),
    status: () => (httpServer ? 'running' : startError ? 'error' : 'stopped'),
    error: () => startError
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (stopping) {
      sendJsonRpcError(res, 503, -32000, 'MCP server is stopping.')
      return
    }
    if (!authorized(req, options.getSettings().token)) {
      sendJson(res, 401, { error: 'Invalid or missing Bearer token.' }, 'Bearer')
      return
    }
    if (!isMcpPath(req.url)) {
      sendJson(res, 404, { error: 'Not found.' })
      return
    }

    if (req.method === 'POST') {
      await handlePost(req, res)
      return
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = findSession(req)
      if (!session) {
        sendJsonRpcError(res, 404, -32000, 'Invalid or missing MCP session ID.')
        return
      }
      await session.transport.handleRequest(req, res)
      return
    }
    res.writeHead(405, { Allow: 'POST, GET, DELETE' })
    res.end()
  }

  async function handlePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    const sessionId = header(req, 'mcp-session-id')
    let session = sessionId ? sessions.get(sessionId) : undefined

    if (!session && !sessionId && isInitializeRequest(body)) {
      session = await createProtocolSession()
    } else if (!session) {
      sendJsonRpcError(res, sessionId ? 404 : 400, -32000, 'Invalid or missing MCP session ID.')
      return
    }
    await session.transport.handleRequest(req, res, body)
  }

  async function createProtocolSession(): Promise<ProtocolSession> {
    let transport!: StreamableHTTPServerTransport
    const server = createMcpProtocolServer(options, () => {
      if (!transport.sessionId) throw new Error('MCP session is not initialized.')
      return transport.sessionId
    })
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      // Tool calls use request-scoped SSE so notifications/progress and the final
      // JSON-RPC response share one MCP request. This is the stable MCP callback
      // path; background recovery additionally uses zhumora_wait + task cursor.
      enableJsonResponse: false,
      onsessioninitialized: sessionId => {
        sessions.set(sessionId, { transport, server })
      }
    })
    transport.onclose = () => {
      const sessionId = transport.sessionId
      if (sessionId) sessions.delete(sessionId)
    }
    transport.onerror = error => log('warn', `MCP transport error: ${safeError(error)}`)
    await server.connect(transport)
    return { transport, server }
  }

  function findSession(req: http.IncomingMessage): ProtocolSession | undefined {
    const sessionId = header(req, 'mcp-session-id')
    return sessionId ? sessions.get(sessionId) : undefined
  }
}

function listen(server: http.Server, requestedPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort > 0 ? requestedPort : 0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  if (!token) return false
  const value = req.headers.authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(value)
  if (!match) return false
  const provided = Buffer.from(match[1])
  const expected = Buffer.from(token)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

function isMcpPath(url: string | undefined): boolean {
  if (!url) return false
  try {
    const path = new URL(url, 'http://127.0.0.1').pathname
    return path === '/mcp' || path === '/'
  } catch {
    return false
  }
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown | undefined> {
  const raw = await readBody(req)
  if (raw === null) {
    sendJsonRpcError(res, 413, -32000, 'Request body too large.')
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch {
    sendJsonRpcError(res, 400, -32700, 'Invalid JSON.')
    return undefined
  }
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise(resolve => {
    let size = 0
    let oversized = false
    const chunks: Buffer[] = []
    req.on('data', chunk => {
      if (oversized) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        oversized = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(oversized ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

function sendJsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: null, error: { code, message } })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, authRealm?: string): void {
  const payload = JSON.stringify(body)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload))
  }
  if (authRealm) {
    // 标准 401 要带 WWW-Authenticate：让客户端明确这是 Bearer 凭据问题，
    // 而不是泛泛的 HTTP 401（MCP 客户端的报错文案会引用它）。
    headers['WWW-Authenticate'] = `Bearer realm="${authRealm}"`
  }
  res.writeHead(status, headers)
  res.end(payload)
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}
