// ============================================================
// MCP 入站服务器 — loopback HTTP + Bearer token 传输层。
// Streamable HTTP、JSON-RPC、协议协商与 session 生命周期全部交给官方 SDK；
// 本文件只负责 HTTP 边界、鉴权、按 session 路由和 Zhumora 工具适配。
// 会话与 Agent 运行规则仍全部在 service.ts / SessionService。
// ============================================================
import { randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
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

interface ProtocolSession {
  transport: StreamableHTTPServerTransport
  server: McpServer
}

const MAX_BODY_BYTES = 1024 * 1024
const MAX_WAIT_MS = 10 * 60 * 1000
const DEFAULT_WAIT_MS = 60_000

const SERVER_INSTRUCTIONS = [
  'Zhumora is a desktop AI agent on this Windows machine.',
  'Delegate tasks with zhumora_chat and keep using the same MCP session for follow-up status and permission calls.',
  'If zhumora_chat returns running, poll zhumora_status instead of sending the task again.',
  'Only call zhumora_respond when the status says decidable_by_you=true; otherwise the human must decide in Zhumora.'
].join(' ')

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
    const current = httpServer
    httpServer = null
    if (current) {
      current.closeIdleConnections?.()
      await new Promise<void>(resolve => current.close(() => resolve()))
    }
    const active = [...sessions.values()]
    sessions.clear()
    await Promise.allSettled(active.map(session => session.server.close()))
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
      sendJson(res, 401, { error: 'Invalid or missing Bearer token.' })
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
    const server = createProtocolServer(options, () => {
      if (!transport.sessionId) throw new Error('MCP session is not initialized.')
      return transport.sessionId
    })
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      // Zhumora has no server-initiated notifications; direct JSON keeps tool calls
      // compatible with Codex while avoiding an unnecessary per-request SSE stream.
      enableJsonResponse: true,
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

function createProtocolServer(
  options: { service: McpInboundService; getSettings: () => McpServerSettings },
  conversationKey: () => string
): McpServer {
  const server = new McpServer(
    { name: 'zhumora', version: '0.4.4' },
    { instructions: SERVER_INSTRUCTIONS }
  )

  server.registerTool('zhumora_chat', {
    description: [
      'Send a delegated task or message to the Zhumora desktop agent. Zhumora runs a full',
      'agent session (files, shell, browser, Windows desktop control, Office documents) and',
      'returns its final reply. If the result is running, poll zhumora_status with the same',
      'MCP session instead of sending a duplicate message.'
    ].join(' '),
    inputSchema: {
      message: z.string().describe('The task or message to delegate.'),
      wait_ms: z.number().finite().optional().describe(
        `Maximum time to wait in milliseconds (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}). 0 returns immediately.`
      )
    }
  }, async ({ message, wait_ms }) => {
    const waitMs = Math.max(0, Math.min(wait_ms ?? DEFAULT_WAIT_MS, MAX_WAIT_MS))
    return toToolResult(options, await options.service.chat(conversationKey(), message, waitMs))
  })

  server.registerTool('zhumora_respond', {
    description: [
      'Approve or deny a pending Zhumora permission request only when zhumora_status reports',
      'decidable_by_you=true. Other requests must be decided by the human in the Zhumora UI.'
    ].join(' '),
    inputSchema: {
      permission_id: z.string(),
      allow: z.boolean(),
      reason: z.string().optional().describe('Short justification recorded in Zhumora logs.')
    }
  }, async ({ permission_id, allow, reason }) => {
    return toToolResult(options, options.service.respond(conversationKey(), permission_id, allow, reason))
  })

  server.registerTool('zhumora_status', {
    description: 'Get the current Zhumora task status for this MCP session.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => toToolResult(options, options.service.status(conversationKey())))

  return server
}

function toToolResult(
  options: { service: McpInboundService; getSettings: () => McpServerSettings },
  status: ReturnType<McpInboundService['status']>
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const canDecide = status.status === 'awaiting_permission'
    ? options.service.canExternalDecide(status.permission)
    : false
  const payload = status.status === 'awaiting_permission'
    ? {
        ...status,
        decidable_by_you: canDecide,
        guidance: canDecide
          ? 'You may call zhumora_respond with this permission_id.'
          : 'This decision requires the human user in the Zhumora desktop UI. Poll zhumora_status until it changes.'
      }
    : status
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: status.status === 'failed' ? true : undefined
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}
