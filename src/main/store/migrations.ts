import type Database from 'better-sqlite3'

interface Migration {
  version: number
  up(database: Database.Database): void
}

const migrations: Migration[] = [
  {
    version: 1,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT 'New Session',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          workspace_path TEXT
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
        CREATE TABLE IF NOT EXISTS token_usage (
          model TEXT NOT NULL,
          bucket_start INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          request_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (model, bucket_start)
        );
        CREATE TABLE IF NOT EXISTS compactions (
          session_id TEXT PRIMARY KEY,
          up_to_message_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `)
    }
  },
  {
    version: 2,
    up(database) {
      const tokenColumns = database.prepare('PRAGMA table_info(token_usage)').all() as { name: string }[]
      if (tokenColumns.some(column => column.name === 'session_id') && !tokenColumns.some(column => column.name === 'bucket_start')) {
        database.exec(`
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
      database.exec('CREATE INDEX IF NOT EXISTS idx_token_usage_bucket ON token_usage(bucket_start)')

      const sessionColumns = database.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
      if (!sessionColumns.some(column => column.name === 'workspace_path')) {
        database.exec('ALTER TABLE sessions ADD COLUMN workspace_path TEXT')
      }

      const messageColumns = database.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
      if (!messageColumns.some(column => column.name === 'images')) {
        database.exec('ALTER TABLE messages ADD COLUMN images TEXT')
      }
      if (!messageColumns.some(column => column.name === 'reasoning')) {
        database.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT')
      }
    }
  },
  {
    version: 3,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS bot_sessions (
          channel TEXT NOT NULL,
          account_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          PRIMARY KEY (channel, account_id, conversation_id),
          UNIQUE (session_id),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_bot_sessions_session ON bot_sessions(session_id);
      `)
    }
  }
]

export const DATABASE_SCHEMA_VERSION = migrations[migrations.length - 1].version

export function runDatabaseMigrations(database: Database.Database): void {
  const current = database.pragma('user_version', { simple: true }) as number
  for (const migration of migrations) {
    if (migration.version <= current) continue
    database.transaction(() => {
      migration.up(database)
      database.pragma(`user_version = ${migration.version}`)
    })()
  }
}
