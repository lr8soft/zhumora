import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { DATABASE_SCHEMA_VERSION, runDatabaseMigrations } from '../src/main/store/migrations.ts'

const fresh = new Database(':memory:')
runDatabaseMigrations(fresh)
assert.equal(fresh.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
assert.ok((fresh.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).some(column => column.name === 'reasoning'))
assert.ok((fresh.prepare('PRAGMA table_info(bot_sessions)').all() as { name: string }[]).some(column => column.name === 'conversation_id'))
fresh.close()

const legacy = new Database(':memory:')
legacy.exec(`
  CREATE TABLE token_usage (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  INSERT INTO token_usage VALUES ('1', 's', 'model', 10, 20, 1000);
`)
runDatabaseMigrations(legacy)
const tokenColumns = legacy.prepare('PRAGMA table_info(token_usage)').all() as { name: string }[]
assert.ok(tokenColumns.some(column => column.name === 'bucket_start'))
assert.ok(!tokenColumns.some(column => column.name === 'session_id'))
assert.deepEqual(legacy.prepare('SELECT model, input_tokens, output_tokens, request_count FROM token_usage').get(), {
  model: 'model', input_tokens: 10, output_tokens: 20, request_count: 1
})
assert.ok((legacy.prepare('PRAGMA table_info(bot_sessions)').all() as { name: string }[]).some(column => column.name === 'session_id'))
legacy.close()

const previousVersion = new Database(':memory:')
previousVersion.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New Session',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    workspace_path TEXT
  );
  PRAGMA user_version = 2;
`)
runDatabaseMigrations(previousVersion)
assert.equal(previousVersion.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
assert.ok((previousVersion.prepare('PRAGMA table_info(bot_sessions)').all() as { name: string }[]).some(column => column.name === 'account_id'))
previousVersion.close()

console.log('database migration tests passed')
