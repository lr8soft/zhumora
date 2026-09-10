import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { DATABASE_SCHEMA_VERSION, runDatabaseMigrations } from '../src/main/store/migrations.ts'

function tableExists(database: Database.Database, name: string): boolean {
  return !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

const fresh = new Database(':memory:')
runDatabaseMigrations(fresh)
assert.equal(fresh.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
assert.ok((fresh.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).some(column => column.name === 'reasoning'))
assert.ok((fresh.prepare('PRAGMA table_info(bot_sessions)').all() as { name: string }[]).some(column => column.name === 'conversation_id'))
assert.ok((fresh.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(column => column.name === 'avatar_enabled'))
assert.ok((fresh.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(column => column.name === 'avatar_model_id'))
assert.ok((fresh.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(column => column.name === 'tts_enabled'))
assert.equal(tableExists(fresh, 'scheduled_jobs'), false)
assert.equal(tableExists(fresh, 'scheduled_runs'), false)
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
assert.ok((previousVersion.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(column => column.name === 'avatar_enabled'))
assert.ok((previousVersion.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(column => column.name === 'tts_enabled'))
previousVersion.close()

const v5 = new Database(':memory:')
v5.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New Session',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    workspace_path TEXT,
    avatar_enabled INTEGER NOT NULL DEFAULT 0,
    avatar_model_id TEXT,
    tts_enabled INTEGER NOT NULL DEFAULT 0
  );
  PRAGMA user_version = 5;
`)
runDatabaseMigrations(v5)
assert.equal(v5.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
assert.equal(tableExists(v5, 'scheduled_jobs'), false)
assert.equal(tableExists(v5, 'scheduled_runs'), false)
v5.close()

const v7 = new Database(':memory:')
v7.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE scheduled_jobs (id TEXT PRIMARY KEY);
  CREATE TABLE scheduled_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id) ON DELETE CASCADE
  );
  INSERT INTO scheduled_jobs VALUES ('job-1');
  INSERT INTO scheduled_runs VALUES ('run-1', 'job-1');
  PRAGMA user_version = 7;
`)
runDatabaseMigrations(v7)
assert.equal(v7.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
assert.equal(tableExists(v7, 'scheduled_jobs'), false)
assert.equal(tableExists(v7, 'scheduled_runs'), false)
v7.close()

console.log('database migration tests passed')
