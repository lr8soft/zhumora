// ============================================================
// MCP 自管理工具 — 让 LLM Agent 自己新增 / 修改 / 删除 MCP 服务器
//
// 安全设计（纵深防御）：
// 1. 所有写操作权限等级为 dangerous，且标记 alwaysConfirm ——
//    即使在 full（全自动批准）模式下也强制弹窗，弹窗展示完整 config。
// 2. 配置白名单校验：type 枚举、stdio command 白名单（可用
//    ZHUMORA_MCP_ALLOW_ALL_COMMANDS=1 关闭）、shell 元字符拒绝、
//    URL 仅 http/https、env/headers 数量与长度上限。
// 3. 写入即持久化到 settings DB（与前端设置页同源），并立即尝试
//    连接；连接失败时配置保留为 disabled 状态，返回明确错误让
//    LLM 自行修正或移除。
// ============================================================
import type { McpServerConfig } from '../../shared/types'
import * as db from '../store/db'
import type { ToolHandler } from '../tools/registry'
import { connectMcpServer, disconnectMcpServer, getMcpConnectionStatus } from './client'
import { log } from '../llm/logger'
import { broadcastSettingsChanged } from '../store/settingsBus'

// ---- 常量 ----

const NAME_RE = /^[\w][\w .\-+()]{0,63}$/
const ID_CHARS_RE = /^[\w\-]{1,48}$/
const SHELL_META_RE = /[|&;<>`$]/
const URL_SCHEME_RE = /^https?:\/\//i

/** stdio command 白名单（按 basename 匹配，平台感知）
 *  环境变量 ZHUMORA_MCP_ALLOW_ALL_COMMANDS=1 可关闭白名单（高级用户） */
const COMMAND_WHITELIST = new Set<string>([
  'node', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'uvx', 'uv', 'pipx',
  'python', 'python3', 'pythonw', 'py',
  'java', 'dotnet', 'go', 'ruby', 'perl', 'php',
  'docker', 'docker-compose'
])

function isCommandWhitelistEnabled(): boolean {
  return process.env.ZHUMORA_MCP_ALLOW_ALL_COMMANDS !== '1'
}

function getCommandBaseName(cmd: string): string {
  // 同时按 / 和 \ 拆分（跨平台）；.exe/.cmd/.bat 后缀归一化
  const parts = cmd.split(/[\\/]/)
  let base = parts[parts.length - 1]
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
}

// ---- 配置校验 ----

function validateMcpConfig(input: Record<string, unknown>): { config?: McpServerConfig; error?: string } {
  const name = input.name
  if (typeof name !== 'string' || !NAME_RE.test(name.trim())) {
    return { error: 'Invalid name: use 1-64 characters (letters, digits, spaces, . _ - + ()), no control chars.' }
  }

  const type = input.type
  if (type !== 'stdio' && type !== 'sse' && type !== 'streamable-http') {
    return { error: 'Invalid type: must be "stdio", "sse" or "streamable-http".' }
  }

  const enabled = input.enabled === true ? true : false

  // ---- id 生成（保留调用方传入的合法 id，用于 update 场景） ----
  let id: string
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !ID_CHARS_RE.test(input.id)) {
      return { error: 'Invalid id: must match /^[\\w-]{1,48}$/' }
    }
    id = input.id
  } else {
    const rand = Math.random().toString(36).slice(2, 8)
    id = `mcp-${Date.now().toString(36)}-${rand}`
  }

  const config: McpServerConfig = { id, name: name.trim(), type, enabled }

  if (type === 'stdio') {
    const command = input.command
    if (typeof command !== 'string' || command.trim().length === 0) {
      return { error: 'stdio type requires "command" (e.g. "npx" or "node").' }
    }
    const trimmed = command.trim()
    if (SHELL_META_RE.test(trimmed)) {
      return { error: 'command contains shell metacharacters (| & ; < > ` $), which are not allowed. Pass the executable and arguments separately.' }
    }
    if (isCommandWhitelistEnabled() && !COMMAND_WHITELIST.has(getCommandBaseName(trimmed))) {
      return { error: `command "${trimmed}" is not in the allowed interpreter whitelist (node/npx/python/uvx/docker/java/dotnet/...). Set env ZHUMORA_MCP_ALLOW_ALL_COMMANDS=1 on the main process to disable the whitelist.` }
    }
    config.command = trimmed

    const args = input.args
    if (args !== undefined) {
      if (!Array.isArray(args) || !args.every(a => typeof a === 'string' && a.length <= 512 && !SHELL_META_RE.test(a))) {
        return { error: 'Invalid args: must be an array of strings (each <=512 chars, no shell metacharacters).' }
      }
      config.args = args
    }

    const env = input.env
    if (env !== undefined) {
      if (typeof env !== 'object' || env === null || Array.isArray(env) || Object.keys(env).length > 20) {
        return { error: 'Invalid env: must be a flat object with at most 20 entries.' }
      }
      for (const [k, v] of Object.entries(env)) {
        if (typeof k !== 'string' || k.length > 64 || typeof v !== 'string' || v.length > 512) {
          return { error: `Invalid env entry "${k}": key <=64 chars, value must be a string <=512 chars.` }
        }
        if (SHELL_META_RE.test(k)) return { error: `Invalid env key "${k}".` }
      }
      config.env = env as Record<string, string>
    }
  } else {
    const url = input.url
    if (typeof url !== 'string' || !URL_SCHEME_RE.test(url) || url.length > 512) {
      return { error: `${type} type requires "url" starting with http:// or https:// (<=512 chars).` }
    }
    try {
      new URL(url)
    } catch {
      return { error: `Invalid url: "${url}" is not a valid URL.` }
    }
    config.url = url

    const headers = input.headers
    if (headers !== undefined) {
      if (typeof headers !== 'object' || headers === null || Array.isArray(headers) || Object.keys(headers).length > 10) {
        return { error: 'Invalid headers: must be a flat object with at most 10 entries.' }
      }
      for (const [k, v] of Object.entries(headers)) {
        if (typeof k !== 'string' || k.length > 64 || typeof v !== 'string' || v.length > 1024) {
          return { error: `Invalid header "${k}": name <=64 chars, value must be a string <=1024 chars.` }
        }
      }
      config.headers = headers as Record<string, string>
    }
  }

  // 认证快捷字段（sse / streamable-http）
  if (input.authType !== undefined) {
    if (input.authType !== 'none' && input.authType !== 'bearer' && input.authType !== 'apikey' && input.authType !== 'custom') {
      return { error: 'Invalid authType: must be none/bearer/apikey/custom.' }
    }
    config.authType = input.authType
  }
  for (const key of ['authToken', 'apiKey', 'authHeader'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || (input[key] as string).length > 1024) {
        return { error: `Invalid ${key}: must be a string <=1024 chars.` }
      }
      config[key] = input[key] as string
    }
  }

  return { config }
}

/** 读取当前 settings 并追加/替换/删除 MCP 配置，写回 DB。返回最新列表 */
function persistMcpServers(mutate: (servers: McpServerConfig[]) => McpServerConfig[]): McpServerConfig[] {
  const settings = db.getSettings()
  const servers = Array.isArray(settings.mcpServers) ? [...settings.mcpServers] : []
  const next = mutate(servers)
  db.saveSettings({ ...settings, mcpServers: next })
  // 通知渲染进程刷新设置（设置页实时反映 agent 的变更）
  broadcastSettingsChanged()
  return next
}

// ---- 工具实现 ----

// 只读：列出所有 MCP 服务器 + 连接状态
export const mcpListServersTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'mcp_list_servers',
      description: '列出所有已配置的 MCP 服务器及其连接状态和配置详情（只读）。修改 MCP 配置前先用它查看现状。',
      parameters: { type: 'object', properties: {} }
    }
  },
  permission: 'safe',
  async execute() {
    const servers = Array.isArray(db.getSettings().mcpServers) ? db.getSettings().mcpServers : []
    const statuses = new Map(getMcpConnectionStatus().map(s => [s.id, s.connected]))
    const rows = servers.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      enabled: s.enabled,
      connected: statuses.get(s.id) === true,
      config: s
    }))
    return rows.length === 0
      ? 'No MCP servers configured.'
      : JSON.stringify(rows, null, 2)
  }
}

// 新增 MCP 服务器（危险：stdio = 执行本地命令）
export const mcpAddServerTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'mcp_add_server',
      description: '新增一个 MCP 服务器（stdio/sse/streamable-http），持久化到设置并立即连接。stdio 类型的 command 会在本地执行——属于高危操作，仅在用户明确要求接入某个 MCP 服务器时使用，并在调用前向用户说明将执行什么命令 / 连接什么地址。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '服务器显示名称（1-64 字符）' },
          type: { type: 'string', enum: ['stdio', 'sse', 'streamable-http'], description: '传输类型' },
          command: { type: 'string', description: 'stdio 模式：可执行程序（如 "npx"、"uvx"），需通过白名单校验' },
          args: { type: 'array', items: { type: 'string' }, description: 'stdio 模式：命令参数（如 ["-y", "@modelcontextprotocol/server-filesystem", "/path"]）' },
          env: { type: 'object', description: 'stdio 模式：额外环境变量（最多 20 项）' },
          url: { type: 'string', description: 'sse / streamable-http 模式：服务器 URL（http/https）' },
          headers: { type: 'object', description: 'sse / streamable-http 模式：自定义请求头（最多 10 项）' },
          authType: { type: 'string', enum: ['none', 'bearer', 'apikey', 'custom'], description: '认证类型' },
          authToken: { type: 'string', description: 'authType=bearer 时的 Token' },
          apiKey: { type: 'string', description: 'authType=apikey 时的 Key' },
          authHeader: { type: 'string', description: 'apikey 使用的 header 名（默认 X-API-Key）' },
          enabled: { type: 'boolean', description: '是否启用（默认 true）' }
        },
        required: ['name', 'type']
      }
    }
  },
  permission: 'dangerous',
  alwaysConfirm: true,
  async execute(args) {
    const { config, error } = validateMcpConfig(args)
    if (error || !config) return `Validation failed: ${error}`

    const existing = db.getSettings().mcpServers || []
    if (existing.some(s => s.id === config.id)) {
      return `Server id "${config.id}" already exists. Use mcp_update_server instead.`
    }
    if (existing.some(s => s.name.toLowerCase() === config.name.toLowerCase())) {
      return `A server named "${config.name}" already exists. Use a different name or mcp_update_server.`
    }

    // 1) 持久化（与前端设置页同源）
    const servers = persistMcpServers(list => [...list, config!])
    log('info', `MCP server added by agent: "${config.name}" (${config.type}, id=${config.id})`)

    // 2) 立即尝试连接
    const result = await tryConnect(config)

    return [
      `Added MCP server "${config.name}" (id=${config.id}, ${config.type}).`,
      result,
      `Total servers: ${servers.length}. The new tools will appear in the next agent round.`,
      'Note: this change is persisted to settings and will auto-connect on app startup.'
    ].join('\n')
  }
}

// 修改 MCP 服务器（整包替换该 id 的配置）
export const mcpUpdateServerTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'mcp_update_server',
      description: '修改已存在的 MCP 服务器（按 id 整包替换配置，需传完整字段），持久化并重连。高危操作，仅在用户明确要求时使用。修改前先 mcp_list_servers 查看现有配置。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要修改的服务器 id（mcp_list_servers 可查）' },
          name: { type: 'string', description: '服务器显示名称' },
          type: { type: 'string', enum: ['stdio', 'sse', 'streamable-http'], description: '传输类型' },
          command: { type: 'string', description: 'stdio 模式：可执行程序' },
          args: { type: 'array', items: { type: 'string' }, description: 'stdio 模式：命令参数' },
          env: { type: 'object', description: 'stdio 模式：额外环境变量' },
          url: { type: 'string', description: 'sse / streamable-http 模式：URL' },
          headers: { type: 'object', description: 'sse / streamable-http 模式：自定义请求头' },
          authType: { type: 'string', enum: ['none', 'bearer', 'apikey', 'custom'], description: '认证类型' },
          authToken: { type: 'string', description: 'Bearer Token' },
          apiKey: { type: 'string', description: 'API Key' },
          authHeader: { type: 'string', description: 'apikey header 名' },
          enabled: { type: 'boolean', description: '是否启用' }
        },
        required: ['id', 'name', 'type']
      }
    }
  },
  permission: 'dangerous',
  alwaysConfirm: true,
  async execute(args) {
    const serverId = args.id as string
    const existing = db.getSettings().mcpServers || []
    const target = existing.find(s => s.id === serverId)
    if (!target) {
      return `Server id "${serverId}" not found. Use mcp_list_servers to see existing servers, or mcp_add_server to create one.`
    }

    const { config, error } = validateMcpConfig(args)
    if (error || !config) return `Validation failed: ${error}`
    // id 以目标服务器为准（忽略校验时生成的随机 id）
    config.id = serverId

    const servers = persistMcpServers(list =>
      list.map(s => (s.id === serverId ? config! : s))
    )
    log('info', `MCP server updated by agent: "${config.name}" (${config.type}, id=${serverId})`)

    const result = await tryConnect(config)

    return [
      `Updated MCP server "${config.name}" (id=${serverId}, ${config.type}).`,
      result,
      `Total servers: ${servers.length}.`
    ].join('\n')
  }
}

// 删除 MCP 服务器（断开 + 移除配置）
export const mcpRemoveServerTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'mcp_remove_server',
      description: '删除一个 MCP 服务器：断开连接、注销其工具并从设置中移除（高危，操作不可撤销，仅在用户明确要求时使用）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删除的服务器 id（mcp_list_servers 可查）' }
        },
        required: ['id']
      }
    }
  },
  permission: 'dangerous',
  alwaysConfirm: true,
  async execute(args) {
    const serverId = args.id as string
    const existing = db.getSettings().mcpServers || []
    const target = existing.find(s => s.id === serverId)
    if (!target) {
      return `Server id "${serverId}" not found. Nothing to remove.`
    }

    await disconnectMcpServer(serverId)
    const servers = persistMcpServers(list => list.filter(s => s.id !== serverId))
    log('info', `MCP server removed by agent: "${target.name}" (id=${serverId})`)

    return `Removed MCP server "${target.name}" (id=${serverId}). Its tools have been unregistered. Total servers: ${servers.length}.`
  }
}

/** 连接服务器；失败时把配置置为 disabled（避免每次启动反复重连失败），返回给 LLM 的状态文本 */
async function tryConnect(config: McpServerConfig): Promise<string> {
  if (!config.enabled) return 'Server saved but disabled (enabled=false).'
  try {
    await connectMcpServer(config)
    const status = getMcpConnectionStatus().find(s => s.id === config.id)
    if (status?.connected) {
      return 'Connection succeeded — its tools are now available.'
    }
    return `Connection not yet ready (state: ${status ? 'connecting' : 'unknown'}); it may still be connecting in the background.`
  } catch (err) {
    const msg = (err as Error).message
    // 连接失败：保留配置但置为 disabled，避免启动时反复重连
    persistMcpServers(list =>
      list.map(s => (s.id === config.id ? { ...s, enabled: false } : s))
    )
    log('warn', `MCP agent-added server "${config.name}" failed to connect: ${msg}; marked disabled`)
    return `Connection FAILED: ${msg}\nThe config is saved but marked disabled. Fix the configuration with mcp_update_server (set enabled=true) or remove it with mcp_remove_server.`
  }
}

export const mcpManagerTools: { name: string; handler: ToolHandler }[] = [
  { name: 'mcp_list_servers', handler: mcpListServersTool },
  { name: 'mcp_add_server', handler: mcpAddServerTool },
  { name: 'mcp_update_server', handler: mcpUpdateServerTool },
  { name: 'mcp_remove_server', handler: mcpRemoveServerTool }
]
