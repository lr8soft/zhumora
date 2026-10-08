import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { DATABASE_SCHEMA_VERSION, runDatabaseMigrations } from '../src/main/store/migrations.ts'

const fresh = new Database(':memory:')
runDatabaseMigrations(fresh)
assert.equal(fresh.pragma('user_version', { simple: true }), DATABASE_SCHEMA_VERSION)
assert.ok((fresh.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).some(column => column.name === 'reasoning'))
assert.ok((fresh.prepare('PRAGMA table_info(bot_sessions)').all() as { name: string }[]).some(column => column.name === 'conversation_id'))
assert.ok((fresh.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(column => column.name === 'avatar_enabled'))
assert.ok((fresh.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(column => column.name === 'avatar_model_id'))
assert.ok((fresh.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(column => column.name === 'tts_enabled'))
for (const name of ['subagent_parent_id', 'subagent_provider_id', 'subagent_model']) {
  assert.ok((fresh.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(column => column.name === name))
}
runDatabaseMigrations(fresh)
fresh.close()

// Previous production schema (v5): upgrade keeps all existing messages/settings.
const v5 = new Database(':memory:')
v5.exec(`
  CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER,
    workspace_path TEXT, avatar_enabled INTEGER, avatar_model_id TEXT, tts_enabled INTEGER);
  CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO sessions VALUES ('parent', 'preserved', 1, 2, 'D:/work', 0, NULL, 0);
  INSERT INTO messages VALUES ('m', 'parent', 'complete history');
  INSERT INTO settings VALUES ('settings', '{"activeProviderId":"p"}');
  PRAGMA user_version = 5;
`)
runDatabaseMigrations(v5)
runDatabaseMigrations(v5)
assert.equal(v5.pragma('user_version', { simple: true }), 6)
assert.equal((v5.prepare('SELECT title FROM sessions').get() as { title: string }).title, 'preserved')
assert.equal((v5.prepare('SELECT content FROM messages').get() as { content: string }).content, 'complete history')
assert.equal((v5.prepare('SELECT value FROM settings').get() as { value: string }).value, '{"activeProviderId":"p"}')
v5.prepare(`INSERT INTO sessions (id, subagent_parent_id, subagent_provider_id, subagent_model)
  VALUES (?, ?, ?, ?)`).run('child', 'parent', 'provider-b', 'model-b')
assert.deepEqual(v5.prepare('SELECT subagent_parent_id, subagent_provider_id, subagent_model FROM sessions WHERE id=?').get('child'),
  { subagent_parent_id: 'parent', subagent_provider_id: 'provider-b', subagent_model: 'model-b' })
v5.close()

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

console.log('database migration tests passed')
