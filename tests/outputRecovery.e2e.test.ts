import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { AppSettings, ChatMessage, Session, UIMessage } from '../src/shared/types.ts'
import type { SessionStore } from '../src/main/agent/sessionContracts.ts'
import { runDatabaseMigrations } from '../src/main/store/migrations.ts'
import { insertMessage, selectMessages } from '../src/main/store/messageRepository.ts'
import { ToolOutputStore } from '../src/main/tools/toolOutputStore.ts'
import { createToolOutputReader } from '../src/main/tools/toolOutputReader.ts'
import { createToolOutputLister } from '../src/main/tools/toolOutputLister.ts'
import { recoverableToolOutput } from '../src/main/tools/recoverableOutput.ts'
import { ToolRegistry, normalizeToolOutput } from '../src/main/tools/registry.ts'
import { SessionService } from '../src/main/agent/sessionService.ts'
import { PermissionBroker } from '../src/main/agent/permissionBroker.ts'
import { mapPersistedHistory } from '../src/main/agent/messageMapper.ts'
import { extractTextContent } from '../src/shared/multimodal.ts'
import { WorkingConversation } from '../src/main/agent/workingConversation.ts'
import { buildEffectiveConversation } from '../src/main/agent/history.ts'

register('./helpers/compactionLoader.mjs', import.meta.url)
const { runAgent } = await import('../src/main/agent/runner.ts')
const { AutoCompactor } = await import('../src/main/agent/autoCompact.ts')
const { planAutoCompact } = await import('../src/main/agent/compaction.ts')
const provider = { id: 'recovery', name: 'recovery', baseUrl: 'https://fixture.invalid/v1', apiKey: '', defaultModel: 'model', enabled: true, contextWindow: 128000 }
const sessionId = 'durable-session'
const full = Array.from({ length: 3000 }, (_, i) => `LOG-${i + 1}: ${i === 1500 ? 'ORIGINAL_MIDDLE_MARKER' : 'x'.repeat(100)}`).join('\n')
const body = (message: ChatMessage) => extractTextContent(message.content)
const sse = (delta: object, finish = 'stop') => new Response([
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`, 'data: [DONE]\n\n'
].join(''), { headers: { 'content-type': 'text/event-stream' } })
const call = (name: string, args: object, id: string) => sse({ tool_calls: [
  { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
] }, 'tool_calls')

if (process.argv[2] === '--restart') {
  const root = process.argv[3]
  const database = new Database(path.join(root, 'history.db'))
  const outputs = new ToolOutputStore(path.join(root, 'outputs'))
  try {
    runDatabaseMigrations(database)
    const source = { getMessages: (id: string) => selectMessages(database, id) }
    const listing = normalizeToolOutput(await createToolOutputLister(outputs, source).execute({ pattern: 'emit_log' }, { workspacePath: root, sessionId }))
    const found = JSON.parse(listing.content).results.find((entry: { available: boolean }) => entry.available)
    assert.ok(found, 'restart discovery uses history plus disk, never an in-memory ID map')
    const result = normalizeToolOutput(await createToolOutputReader(outputs, source).execute({ output_id: found.output_id, pattern: 'ORIGINAL_MIDDLE_MARKER' }, { workspacePath: root, sessionId }))
    assert.match(result.content, /ORIGINAL_MIDDLE_MARKER/)
    const records = source.getMessages(sessionId)
    const compact = database.prepare('SELECT up_to_message_id, summary FROM compactions WHERE session_id=?').get(sessionId) as { up_to_message_id: string; summary: string }
    const mapped = mapPersistedHistory(records)
    const effective = buildEffectiveConversation(mapped.messages, mapped.ids, { upToMessageId: compact.up_to_message_id, summary: compact.summary })
    assert.equal(JSON.stringify(effective.effective).includes(found.output_id), false, 'summary can omit the old ID without making the result undiscoverable')
    process.stdout.write(JSON.stringify({ id: found.output_id, recovered: true, ref: result.outputRef?.id }))
  } finally { database.close(); await outputs.dispose() }
} else {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.test-output-e2e-'))
  const database = new Database(path.join(root, 'history.db'))
  const outputs = new ToolOutputStore(path.join(root, 'outputs'))
  const permissions = new PermissionBroker()
  const oldFetch = globalThis.fetch
  let databaseClosed = false
  let service: SessionService | undefined
  try {
    runDatabaseMigrations(database)
    database.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)').run(sessionId, 'Recovery')
    const session: Session = { id: sessionId, title: 'Recovery', createdAt: 1, updatedAt: 1, messageCount: 0, origin: 'renderer', avatarEnabled: false, ttsEnabled: false }
    const settings = { providers: [provider], activeProviderId: provider.id, workspacePath: root, memoryEnabled: false, maxRounds: 10,
      subagentsEnabled: false, mcpServers: [], skills: [] } as unknown as AppSettings
    const persistence: SessionStore = {
      createSession: () => { throw new Error('unused') }, getSession: id => id === sessionId ? session : null,
      getSessions: () => [session], getSettings: () => settings, updateSessionTitle() {}, updateSessionWorkspace() {}, updateSessionModelSelection() {}, deleteSession() {},
      getOrCreateBotSession: () => session, getMessages: id => selectMessages(database, id),
      addMessage: message => insertMessage(database, { ...message, timestamp: 1 }),
      getSessionCompaction: id => {
        const row = database.prepare('SELECT * FROM compactions WHERE session_id=?').get(id) as { up_to_message_id: string; summary: string; created_at: number } | undefined
        return row ? { sessionId: id, upToMessageId: row.up_to_message_id, summary: row.summary, createdAt: row.created_at } : null
      },
      setSessionCompaction: record => { database.prepare('INSERT OR REPLACE INTO compactions VALUES (?, ?, ?, ?)')
        .run(record.sessionId, record.upToMessageId, record.summary, record.createdAt) },
      tryUpdateSessionTitleIfDefault: () => false, addTokenUsage() {}
    }
    const registry = new ToolRegistry()
    registry.register('emit_log', { permission: 'safe', definition: { type: 'function', function: { name: 'emit_log', description: 'Produce an immutable log fixture', parameters: {} } },
      execute: (_args, context) => recoverableToolOutput(full, context, 'Inspect original logs.') })
    service = new SessionService({ store: persistence, tools: registry, permissions, outputStore: outputs,
      getSkillsPrompt: () => '', getMcpStatus: () => [], executeAgent: runAgent, fetchContextWindow: async () => provider.contextWindow,
      planAutoCompact, completeText: async () => '' })
    const source = { getMessages: (id: string) => service!.getMessages(id) }
    const reader = createToolOutputReader(outputs, source)
    registry.register('read_tool_output', reader); registry.register('list_tool_outputs', createToolOutputLister(outputs, source))
    const filler = (side: string) => {
      for (let i = 0; i < 30; i++) {
        const id = `${side}-${i}`
        persistence.addMessage({ id: `${id}-assistant`, sessionId, role: 'assistant', content: '', timestamp: 1,
          toolCalls: [{ id, type: 'function', function: { name: 'old_tool', arguments: '{}' } }] })
        persistence.addMessage({ id: `${id}-tool`, sessionId, role: 'tool', content: 'context '.repeat(1000), timestamp: 1,
          toolCallId: id, toolName: 'old_tool' })
      }
    }
    filler('before')
    let stage = 0; let summaries = 0; let originalId = ''; let summarySourceHasId = false
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init!.body as string) as { stream?: boolean; messages: ChatMessage[] }
      if (!request.stream) {
        summaries++
        summarySourceHasId ||= !!originalId && JSON.stringify(request.messages).includes(originalId)
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Earlier work is summarized; inspect the original log as needed.' } }] })
      }
      stage++
      if (stage === 1) return call('emit_log', {}, 'produce')
      if (stage === 2) return sse({ content: 'Log captured.' })
      if (stage === 3) {
        assert.equal(JSON.stringify(request.messages).includes(originalId), false, 'the original ID was folded out of effective history')
        assert.match(body(request.messages[0]), /list_tool_outputs/)
        return call('list_tool_outputs', { pattern: 'emit_log' }, 'find')
      }
      if (stage === 4) {
        const result = JSON.parse(body(request.messages.at(-1)!))
        assert.equal(result.results[0].output_id, originalId)
        return call('read_tool_output', { output_id: result.results[0].output_id, pattern: 'ORIGINAL_MIDDLE_MARKER' }, 'resume')
      }
      assert.equal(stage, 5)
      assert.match(body(request.messages.at(-1)!), /ORIGINAL_MIDDLE_MARKER/)
      return sse({ content: 'Original middle log recovered.' })
    }
    const first = await service.sendMessage({ sessionId, message: { text: 'Capture log' } }); await first.completion
    originalId = persistence.getMessages(sessionId).find(message => message.toolName === 'emit_log')!.outputRef!.id
    assert.ok(originalId && !originalId.startsWith('message:'))
    filler('after')
    const second = await service.sendMessage({ sessionId, message: { text: 'Find and read the omitted original middle log' } }); await second.completion
    assert.ok(summaries > 0); assert.equal(summarySourceHasId, false, 'middle reference need not appear even in the summary input')
    assert.deepEqual(persistence.getMessages(sessionId).find(message => message.toolName === 'read_tool_output')!.outputRef, { id: originalId })
    assert.equal((await outputs.list(sessionId)).length, 1, 'new runs and compaction reuse the original artifact')

    const rawPage = normalizeToolOutput(await reader.execute({ output_id: originalId, limit: 200 }, { workspacePath: root, sessionId }))
    const originalNext = Number(/next_offset=(\d+)/.exec(rawPage.content)![1])
    const conversation = new WorkingConversation('Inspect original output')
    conversation.append({ role: 'assistant', content: null, tool_calls: [{ id: 'page', type: 'function', function: { name: 'read_tool_output', arguments: '{}' } }] }, 'page-call')
    conversation.append({ role: 'tool', tool_call_id: 'page', content: rawPage.content, toolOutputRef: rawPage.outputRef }, 'page-result')
    let archives = 0
    await new AutoCompactor({ provider, contextWindow: 2000, archiveToolOutput: async () => { archives++; throw new Error('must reuse original') } }, null)
      .applyIfOverThreshold(conversation, 'reader reprojection')
    assert.equal(archives, 0); assert.equal(conversation.messages.at(-1)!.toolOutputRef!.id, originalId)
    const next = normalizeToolOutput(await reader.execute({ output_id: originalId, offset: originalNext, limit: 1 }, { workspacePath: root, sessionId }))
    assert.match(next.content, new RegExp(`LOG-${originalNext}:`), 'next cursor is still in original-source coordinates')

    const raw: UIMessage = { id: 'large-mcp', sessionId, role: 'tool', content: 'mcp-middle-'.repeat(10000), timestamp: 1, toolName: 'mcp_original' }
    raw.toolCallId = 'raw-mcp-call'
    persistence.addMessage({ id: 'raw-mcp-assistant', sessionId, role: 'assistant', content: '', timestamp: 1,
      toolCalls: [{ id: raw.toolCallId, type: 'function', function: { name: 'mcp_original', arguments: '{}' } }] })
    persistence.addMessage(raw)
    const mapped = mapPersistedHistory([raw]).messages[0]
    assert.equal(mapped.toolOutputRef!.id, 'message:large-mcp')
    const dbResult = normalizeToolOutput(await reader.execute({ output_id: mapped.toolOutputRef!.id, char_offset: 50000, limit: 1 }, { workspacePath: root, sessionId }))
    assert.match(dbResult.content, /mcp-middle/)
    for (let iteration = 0; iteration < 3; iteration++) {
      const restoredRaw = mapPersistedHistory(persistence.getMessages(sessionId).filter(message => message.id === raw.id)).messages[0]
      const projected = new WorkingConversation('Read original MCP result')
      projected.append({ role: 'assistant', content: null, tool_calls: [{ id: raw.toolCallId!, type: 'function', function: { name: raw.toolName!, arguments: '{}' } }] }, 'raw-call')
      projected.append(restoredRaw, raw.id)
      await new AutoCompactor({ provider, contextWindow: 4000, archiveToolOutput: async () => { throw new Error('No duplicate archives allowed') } }, null)
        .applyIfOverThreshold(projected, 'repeated persisted MCP projection')
      assert.equal(projected.messages.at(-1)!.toolOutputRef!.id, 'message:large-mcp')
    }
    assert.equal((await outputs.list(sessionId)).length, 1, 'full DB results require no duplicate disk archives')
    // Fold the successful rediscovery turn as well, so restart must discover the ID again.
    filler('restart')
    const manual = await service.compact(sessionId)
    assert.ok(manual.compressedCount > 0, 'manual SessionService compaction uses the same durable discovery source')
    const allHistory = persistence.getMessages(sessionId)
    const allMapped = mapPersistedHistory(allHistory)
    const effective = buildEffectiveConversation(allMapped.messages, allMapped.ids, persistence.getSessionCompaction(sessionId))
    const effectiveIds = effective.hasSummary ? [null, ...allMapped.ids.slice(effective.keptFromIndex)] : allMapped.ids
    const beforeRestart = new WorkingConversation('Inspect prior results with list_tool_outputs')
    effective.effective.forEach((message, index) => beforeRestart.append(message, effectiveIds[index]))
    await new AutoCompactor({ provider, contextWindow: 16000, archiveToolOutput: text => outputs.save(sessionId, text),
      persist: state => persistence.setSessionCompaction({ sessionId, ...state, createdAt: Date.now() }) }, null)
      .applyIfOverThreshold(beforeRestart, 'before actual process restart')
    assert.equal(JSON.stringify(beforeRestart.messages).includes(originalId), false)
    assert.equal(persistence.getMessages(sessionId).length, allHistory.length, 'compaction does not remove or rewrite stored messages')
    await service.stopAll(); await outputs.dispose(); database.close(); databaseClosed = true
    const restarted = JSON.parse(execFileSync(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--restart', root], { encoding: 'utf8' }))
    assert.deepEqual(restarted, { id: originalId, recovered: true, ref: originalId })
    console.log('Output recovery E2E: actual SessionService/runner/SQLite, middle-summary omission, later-turn discovery, original cursors, DB fallback and real process restart passed')
  } finally {
    globalThis.fetch = oldFetch
    await service?.stopAll(); permissions.dispose(); await outputs.dispose(); if (!databaseClosed) database.close()
    assert.equal(path.dirname(root), process.cwd()); assert.ok(path.basename(root).startsWith('.test-output-e2e-'))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
