// ============================================================
// SQLite 会话持久化
// ============================================================
import Database from 'better-sqlite3'
import * as path from 'node:path'
import { app } from 'electron'
import type { Session, UIMessage, AppSettings, MemoryEntry, MemoryCategory } from '../../shared/types'
import { normalizeQQBotConfig } from '../../shared/qq'
import { runDatabaseMigrations } from './migrations'
import { generateId } from '../id'
import { normalizeTelegramBotConfig } from '../../shared/telegram'

let db: Database.Database | null = null
let settingsCache: AppSettings | null = null

export function initDatabase(): void {
  const userDataPath = app.getPath('userData')
  const dbPath = path.join(userDataPath, 'zhumora.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runDatabaseMigrations(db)
  settingsCache = loadSettings()
  persistSettings(settingsCache)
}

// ============================================================
// Session 操作
// ============================================================

export function createSession(title = 'New Session', workspacePath?: string): Session {
  const id = generateId()
  const now = Date.now()
  db!.prepare('INSERT INTO sessions (id, title, created_at, updated_at, workspace_path) VALUES (?, ?, ?, ?, ?)')
    .run(id, title, now, now, workspacePath || null)
  return { id, title, createdAt: now, updatedAt: now, messageCount: 0, workspacePath }
}

export function getSessions(): Session[] {
  const rows = db!.prepare(`
    SELECT s.*, COUNT(m.id) as msg_count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
  `).all() as any[]
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.msg_count,
    workspacePath: r.workspace_path || undefined
  }))
}

export function getSession(id: string): Session | null {
  const row = db!.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any
  if (!row) return null
  const msgCount = (db!.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(id) as any).c
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: msgCount,
    workspacePath: row.workspace_path || undefined
  }
}

export function updateSessionTitle(id: string, title: string): void {
  db!.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), id)
}

/**
 * 仅当标题仍是默认值时写入（自动命名兜底用，条件更新原子完成）。
 * set_title / 用户手动改名会先改变标题，使该更新自然失效，不会被覆盖。
 */
export function tryUpdateSessionTitleIfDefault(id: string, title: string): boolean {
  const result = db!.prepare(
    "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND (title = 'New Session' OR title = '')"
  ).run(title, Date.now(), id)
  return result.changes > 0
}

export function updateSessionWorkspace(id: string, workspacePath: string): void {
  db!.prepare('UPDATE sessions SET workspace_path = ? WHERE id = ?')
    .run(workspacePath, id)
}

export function deleteSession(id: string): void {
  // 删除会话时清理压缩状态（token_usage 是全局桶，不随会话删除）
  db!.prepare('DELETE FROM compactions WHERE session_id = ?').run(id)
  db!.prepare('DELETE FROM messages WHERE session_id = ?').run(id)
  db!.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function touchSession(id: string): void {
  db!.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}

/** 获取外部 Bot 对话绑定的本地 session；不存在时原子创建并绑定。 */
export function getOrCreateBotSession(
  channel: string,
  accountId: string,
  conversationId: string,
  title: string
): Session {
  const existing = db!.prepare(`
    SELECT s.* FROM bot_sessions b
    JOIN sessions s ON s.id = b.session_id
    WHERE b.channel = ? AND b.account_id = ? AND b.conversation_id = ?
  `).get(channel, accountId, conversationId) as any
  if (existing) {
    const msgCount = (db!.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(existing.id) as any).c
    return {
      id: existing.id,
      title: existing.title,
      createdAt: existing.created_at,
      updatedAt: existing.updated_at,
      messageCount: msgCount,
      workspacePath: existing.workspace_path || undefined
    }
  }

  return db!.transaction(() => {
    const session = createSession(title)
    db!.prepare(`
      INSERT INTO bot_sessions (channel, account_id, conversation_id, session_id)
      VALUES (?, ?, ?, ?)
    `).run(channel, accountId, conversationId, session.id)
    return session
  })()
}

// ============================================================
// Message 操作
// ============================================================

export function addMessage(msg: UIMessage): void {
  db!.prepare(`
    INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls, tool_call_id, tool_name, images, timestamp, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id, msg.sessionId, msg.role, msg.content,
    msg.reasoning || null,
    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    msg.toolCallId, msg.toolName,
    msg.images && msg.images.length > 0 ? JSON.stringify(msg.images) : null,
    msg.timestamp, msg.status || null
  )
  touchSession(msg.sessionId)
}

export function getMessages(sessionId: string): UIMessage[] {
  const rows = db!.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC').all(sessionId) as any[]
  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content || '',
    reasoning: r.reasoning || undefined,
    toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
    images: r.images ? (safeJsonParse<string[]>(r.images) ?? undefined) : undefined,
    toolCallId: r.tool_call_id,
    toolName: r.tool_name,
    timestamp: r.timestamp,
    status: r.status
  }))
}

export function updateMessageContent(id: string, content: string, status?: string): void {
  if (status) {
    db!.prepare('UPDATE messages SET content = ?, status = ? WHERE id = ?').run(content, status, id)
  } else {
    db!.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id)
  }
}

// ============================================================
// Settings 操作
// ============================================================

export const SETTINGS_SCHEMA_VERSION = 4

export function getSettings(): AppSettings {
  if (!settingsCache) settingsCache = db ? loadSettings() : defaultSettings()
  return structuredClone(settingsCache)
}

export function saveSettings(settings: AppSettings): void {
  if (!db) throw new Error('Database has not been initialized')
  const normalized = normalizeSettings(settings)
  persistSettings(normalized)
  settingsCache = normalized
}

function persistSettings(settings: AppSettings): void {
  db!.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('app_settings', JSON.stringify(settings))
}

function defaultSettings(): AppSettings {
  let workspacePath = process.cwd()
  try {
    if (app.isReady()) workspacePath = app.getPath('home')
  } catch { /* Electron app is unavailable in isolated unit tests */ }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    providers: [
      {
        id: 'zhuminet-default',
        name: '煮米 API',
        baseUrl: 'https://api.zhuminet.com/v1',
        apiKey: '',
        defaultModel: 'gpt-4o',
        enabled: true
      }
    ],
    mcpServers: [],
    telegramBot: normalizeTelegramBotConfig(undefined),
    qqBot: normalizeQQBotConfig(undefined),
    skills: [],
    activeProviderId: 'zhuminet-default',
    workspacePath,
    memoryEnabled: true,
    language: 'auto',
    maxRetries: 5,
    maxRounds: 20
  }
}

function loadSettings(): AppSettings {
  const row = db!.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined
  if (!row) return defaultSettings()
  try {
    return normalizeSettings(JSON.parse(row.value))
  } catch {
    return defaultSettings()
  }
}

/** JSON blob 的前向迁移与默认值合并集中在存储边界。 */
export function normalizeSettings(input: unknown): AppSettings {
  const defaults = defaultSettings()
  if (!input || typeof input !== 'object') return defaults
  const raw = input as Partial<AppSettings>
  return {
    ...defaults,
    ...raw,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    providers: Array.isArray(raw.providers) ? raw.providers : defaults.providers,
    mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : defaults.mcpServers,
    telegramBot: normalizeTelegramBotConfig(raw.telegramBot),
    qqBot: normalizeQQBotConfig(raw.qqBot),
    skills: Array.isArray(raw.skills) ? raw.skills : defaults.skills,
    activeProviderId: typeof raw.activeProviderId === 'string' || raw.activeProviderId === null
      ? raw.activeProviderId
      : defaults.activeProviderId,
    workspacePath: typeof raw.workspacePath === 'string' ? raw.workspacePath : defaults.workspacePath
  }
}

/** 容错 JSON 解析（DB 中图片列为 JSON 数组；损坏时返回 null 而非抛异常） */
function safeJsonParse<T>(raw: string): T | null {
  try {
    const v = JSON.parse(raw)
    return (Array.isArray(v) ? v : null) as T
  } catch {
    return null
  }
}

// ============================================================
// Memory 操作 — longterm-skill
// ============================================================

export function addMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessed' | 'accessCount'>): MemoryEntry {
  const id = generateId()
  const now = Date.now()
  db!.prepare(`
    INSERT INTO memory_entries (id, category, content, importance, source_session_id, created_at, last_accessed, access_count, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, entry.category, entry.content, entry.importance, entry.sourceSessionId, now, now, JSON.stringify(entry.tags || []))
  return { ...entry, id, createdAt: now, lastAccessed: now, accessCount: 0 }
}

export function getMemories(options?: { category?: MemoryCategory; limit?: number; search?: string }): MemoryEntry[] {
  let sql = 'SELECT * FROM memory_entries'
  const params: any[] = []
  const conditions: string[] = []

  if (options?.category) {
    conditions.push('category = ?')
    params.push(options.category)
  }
  if (options?.search) {
    conditions.push('(content LIKE ? OR tags LIKE ?)')
    params.push(`%${options.search}%`, `%${options.search}%`)
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ')
  }
  sql += ' ORDER BY importance DESC, last_accessed DESC'
  if (options?.limit) {
    sql += ' LIMIT ?'
    params.push(options.limit)
  }

  const rows = db!.prepare(sql).all(...params) as any[]
  return rows.map(r => ({
    id: r.id,
    category: r.category,
    content: r.content,
    importance: r.importance,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
    lastAccessed: r.last_accessed,
    accessCount: r.access_count,
    tags: r.tags ? JSON.parse(r.tags) : []
  }))
}

export function deleteMemory(id: string): void {
  db!.prepare('DELETE FROM memory_entries WHERE id = ?').run(id)
}

export function clearAllMemories(): void {
  db!.prepare('DELETE FROM memory_entries').run()
}

export function touchMemory(id: string): void {
  db!.prepare('UPDATE memory_entries SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?')
    .run(Date.now(), id)
}

export function updateMemoryImportance(id: string, importance: number): void {
  db!.prepare('UPDATE memory_entries SET importance = ? WHERE id = ?').run(importance, id)
}

// ============================================================
// Token Usage 操作 — 30 分钟桶
//
// 记录粒度：每 30 分钟一个数据点（bucket_start = 桶起点毫秒时间戳，
// 按 1800000ms 对齐）。每次 LLM 调用把用量累加进当前桶（upsert）。
// 桶是全局的（不随会话删除），用量统计跨会话汇总。
// ============================================================

export const TOKEN_USAGE_BUCKET_MS = 30 * 60 * 1000 // 30 分钟

/** 把任意时间戳对齐到 30 分钟桶起点 */
export function bucketStartOf(ts: number): number {
  return Math.floor(ts / TOKEN_USAGE_BUCKET_MS) * TOKEN_USAGE_BUCKET_MS
}

/** 累加一次 LLM 调用到当前 30 分钟桶 */
export function addTokenUsage(model: string, inputTokens: number, outputTokens: number, createdAt: number = Date.now()): void {
  const bucket = bucketStartOf(createdAt)
  db!.prepare(`
    INSERT INTO token_usage (model, bucket_start, input_tokens, output_tokens, request_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(model, bucket_start) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      request_count = request_count + 1
  `).run(model, bucket, inputTokens, outputTokens)
}

export interface TokenUsageSummary {
  model: string
  totalInput: number
  totalOutput: number
  count: number
}

export function getTokenUsageSummary(): TokenUsageSummary[] {
  const rows = db!.prepare(`
    SELECT model, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, SUM(request_count) as count
    FROM token_usage
    GROUP BY model
    ORDER BY total_input + total_output DESC
  `).all() as any[]
  return rows.map(r => ({
    model: r.model,
    totalInput: r.total_input,
    totalOutput: r.total_output,
    count: r.count
  }))
}

export interface TokenUsageBucket {
  /** 桶起点（毫秒时间戳，对齐 30 分钟） */
  bucketStart: number
  model: string
  inputTokens: number
  outputTokens: number
  requestCount: number
}

/**
 * 查询最近 N 天的 30 分钟桶（图表数据源）。
 * 每个 (model, 桶) 一行；无调用的桶没有行，由前端补齐空桶（断点）。
 */
export function getTokenUsageBuckets(days: number = 7): TokenUsageBucket[] {
  const since = bucketStartOf(Date.now() - days * 24 * 60 * 60 * 1000)
  const rows = db!.prepare(`
    SELECT model, bucket_start, input_tokens, output_tokens, request_count
    FROM token_usage
    WHERE bucket_start >= ?
    ORDER BY bucket_start ASC
  `).all(since) as any[]
  return rows.map(r => ({
    bucketStart: r.bucket_start,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    requestCount: r.request_count
  }))
}

// ============================================================
// 上下文压缩状态 — compactions
// 压缩只记录"边界 + 摘要"，不改写 messages 表（用户历史完整保留）。
// ============================================================

export interface CompactionRecord {
  sessionId: string
  /** 该消息（含）之前的所有消息在构建 LLM 上下文时被 summary 替换 */
  upToMessageId: string
  summary: string
  createdAt: number
}

export function setSessionCompaction(record: CompactionRecord): void {
  db!.prepare(`
    INSERT INTO compactions (session_id, up_to_message_id, summary, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      up_to_message_id = excluded.up_to_message_id,
      summary = excluded.summary,
      created_at = excluded.created_at
  `).run(record.sessionId, record.upToMessageId, record.summary, record.createdAt)
}

export function getSessionCompaction(sessionId: string): CompactionRecord | null {
  const row = db!.prepare('SELECT * FROM compactions WHERE session_id = ?').get(sessionId) as any
  if (!row) return null
  return {
    sessionId: row.session_id,
    upToMessageId: row.up_to_message_id,
    summary: row.summary,
    createdAt: row.created_at
  }
}
