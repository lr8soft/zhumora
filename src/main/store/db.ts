// ============================================================
// SQLite 会话持久化
// ============================================================
import Database from 'better-sqlite3'
import * as path from 'node:path'
import { app } from 'electron'
import type { Session, UIMessage, AppSettings, MemoryEntry, MemoryCategory } from '../../shared/types'

let db: Database.Database | null = null

export function initDatabase(): void {
  const userDataPath = app.getPath('userData')
  const dbPath = path.join(userDataPath, 'zhumora.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Session',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      reasoning TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      images TEXT,
      timestamp INTEGER NOT NULL,
      status TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      source_session_id TEXT,
      created_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      tags TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_entries(category);
    CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory_entries(importance DESC);

    -- token_usage：30 分钟桶（全局，不随会话删除）。
    -- 每次 LLM 调用把 input/output 累加进当前 30 分钟桶（upsert），
    -- 一个 (model, bucket_start) = 一个数据点。
    CREATE TABLE IF NOT EXISTS token_usage (
      model TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (model, bucket_start)
    );
    -- 注意：token_usage 的索引在下方"结构迁移"之后再建。
    -- 若库里有旧结构 token_usage（无 bucket_start 列），上面的 CREATE IF NOT EXISTS
    -- 会跳过，必须等迁移把表重建为新结构后才能建 bucket_start 索引，
    -- 否则 "no such column: bucket_start"。

    -- compactions：上下文压缩状态（每会话一行，始终为最新一次压缩）。
    -- 压缩只影响"发给 LLM 的上下文"，不删除/不改写 messages 表，
    -- 用户侧始终能看到完整历史。up_to_message_id 之前的消息在构建
    -- LLM 上下文时会被替换为 summary。
    CREATE TABLE IF NOT EXISTS compactions (
      session_id TEXT PRIMARY KEY,
      up_to_message_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)

  // 迁移：token_usage 旧结构（每次调用一行、session 级联）→ 新结构（30 分钟桶、全局）。
  // 旧库有 session_id 列且无 bucket_start 列时执行；新库直接跳过。
  const tuCols = db!.prepare("PRAGMA table_info(token_usage)").all() as { name: string }[]
  if (tuCols.some(c => c.name === 'session_id') && !tuCols.some(c => c.name === 'bucket_start')) {
    db!.exec(`
      CREATE TABLE token_usage_new (
        model TEXT NOT NULL,
        bucket_start INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (model, bucket_start)
      );
      INSERT INTO token_usage_new (model, bucket_start, input_tokens, output_tokens, request_count)
        SELECT model, (created_at / 1800000) * 1800000, SUM(input_tokens), SUM(output_tokens), COUNT(*)
        FROM token_usage
        GROUP BY model, (created_at / 1800000) * 1800000;
      DROP TABLE token_usage;
      ALTER TABLE token_usage_new RENAME TO token_usage;
    `)
  }

  // token_usage 索引：无论新库还是迁移后的旧库，此时表已是新结构（含 bucket_start）
  db!.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_bucket ON token_usage(bucket_start)')

  // 迁移：给 sessions 加 workspace_path 列（如果不存在）
  const columns = db!.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
  if (!columns.some(c => c.name === 'workspace_path')) {
    db!.exec('ALTER TABLE sessions ADD COLUMN workspace_path TEXT')
  }

  // 迁移：给 messages 加 images 列（用户图片附件，JSON 数组）
  const msgColumns = db!.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
  if (!msgColumns.some(c => c.name === 'images')) {
    db!.exec('ALTER TABLE messages ADD COLUMN images TEXT')
  }

  // 迁移：给 messages 加 reasoning 列（模型思考内容，与 Cline/opencode 对齐：单独存储、不喂回 LLM）
  if (!msgColumns.some(c => c.name === 'reasoning')) {
    db!.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT')
  }
}

// ============================================================
// Session 操作
// ============================================================

export function createSession(title = 'New Session', workspacePath?: string): Session {
  const id = genId()
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
  const rows = db!.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as any[]
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

export function getSettings(): AppSettings {
  const row = db!.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as any
  if (row) {
    try { return JSON.parse(row.value) }
    catch { /* fall through to default */ }
  }
  return defaultSettings()
}

export function saveSettings(settings: AppSettings): void {
  db!.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('app_settings', JSON.stringify(settings))
}

function defaultSettings(): AppSettings {
  return {
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
    skills: [],
    activeProviderId: 'zhuminet-default',
    workspacePath: app.getPath('home'),
    memoryEnabled: true,
    language: 'auto',
    maxRetries: 5,
    maxRounds: 20
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

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// ============================================================
// Memory 操作 — longterm-skill
// ============================================================

export function addMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessed' | 'accessCount'>): MemoryEntry {
  const id = genId()
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
