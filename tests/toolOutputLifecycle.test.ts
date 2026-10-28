import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UIMessage } from '../src/shared/types.ts'
import { ToolOutputStore } from '../src/main/tools/toolOutputStore.ts'
import { createToolOutputReader } from '../src/main/tools/toolOutputReader.ts'
import { createToolOutputLister } from '../src/main/tools/toolOutputLister.ts'
import { normalizeToolOutput } from '../src/main/tools/registry.ts'

const workspace = path.resolve(import.meta.dirname, '..')
const self = fileURLToPath(import.meta.url)
const session = 'persistent-session'
const text = Array.from({ length: 1201 }, (_, index) =>
  `original-${index} ${index === 600 ? 'ORIGINAL_MIDDLE' : 'content'} ${'x'.repeat(50)} 汉😀`).join('\n')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const directory = (root: string, id: string) => path.join(root, digest(id))
const quotaOptions = { maxResultBytes: 64, maxSessionBytes: 64 }
const committedText = 'committed-result'

function cursor(page: string): { offset: number; char_offset: number } | undefined {
  const match = /next_offset=(\d+) next_char_offset=(\d+)/.exec(page)
  return match ? { offset: Number(match[1]), char_offset: Number(match[2]) } : undefined
}

async function child(mode: string, root: string): Promise<void> {
  assert.ok(path.relative(workspace, root).startsWith('.test-output-lifecycle-'))
  const store = new ToolOutputStore(root, mode.startsWith('crash') ? quotaOptions : {})
  if (mode === 'save') {
    const id = await store.save(session, text, { toolName: 'bash', toolCallId: 'original-call', label: 'Persistent original output' })
    await store.dispose()
    console.log(JSON.stringify({ id }))
  } else if (mode === 'read') {
    try {
      const listing = await store.list(session)
      assert.equal(listing.length, 1)
      const saved = listing[0]
      assert.equal(saved.toolName, 'bash')
      assert.equal(saved.toolCallId, 'original-call')
      assert.equal(saved.label, 'Persistent original output')
      assert.equal(saved.bytes, Buffer.byteLength(text))
      assert.match(saved.preview, /original-0/)
      assert.ok(saved.createdAt > 0)
      const reader = createToolOutputReader(store)
      const ctx = { workspacePath: workspace, sessionId: session }
      const middle = normalizeToolOutput(await reader.execute({ output_id: saved.id, pattern: 'ORIGINAL_MIDDLE' }, ctx))
      assert.match(middle.content, /601: original-600 ORIGINAL_MIDDLE/)
      assert.equal(middle.outputRef?.id, saved.id)
      const lines: string[] = []
      let next: ReturnType<typeof cursor> = { offset: 1, char_offset: 0 }
      let pages = 0
      while (next) {
        const page = await store.read(session, saved.id, { ...next, limit: 37 })
        lines.push(...page.split('\n').filter(line => /^\d+(?::\d+)?: /.test(line)).map(line => line.replace(/^\d+(?::\d+)?: /, '')))
        next = cursor(page)
        assert.ok(++pages <= 40)
      }
      assert.equal(lines.join('\n'), text)
      console.log(JSON.stringify({ id: saved.id, hash: digest(lines.join('\n')), pages }))
    } finally { await store.dispose() }
  } else if (mode === 'crash-write') {
    const id = await store.save(session, committedText)
    const writer = await store.createWriter(session)
    await writer.append('p'.repeat(48))
    // Exit without dispose/finish/discard, as a killed application would.
    await new Promise<void>(() => process.stdout.write(JSON.stringify({ id }) + '\n', () => process.exit(0)))
  } else if (mode === 'crash-recover') {
    try {
      await store.cleanup()
      const listing = await store.list(session)
      assert.equal(listing.length, 1)
      assert.match(await store.read(session, listing[0].id), /committed-result/)
      assert.equal((await fs.readdir(directory(root, session))).filter(name => name.endsWith('.partial')).length, 0)
      const added = await store.save(session, 'n'.repeat(48))
      assert.match(await store.read(session, added), /n{48}/)
      assert.equal((await store.list(session)).reduce((total, item) => total + item.bytes, 0), 64,
        'an abandoned partial cannot consume quota in the next process')
      console.log(JSON.stringify({ retained: listing[0].id, added }))
    } finally { await store.dispose() }
  } else { await store.dispose(); throw new Error(`Unknown child mode: ${mode}`) }
}

async function runChild(mode: string, root: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, ['--no-warnings', self, '--child', mode, root], {
      cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''; let stderr = ''; let settled = false
    const timer = setTimeout(() => { processHandle.kill(); fail(new Error(`Child ${mode} timed out`)) }, 15000)
    function fail(error: Error): void {
      if (settled) return
      settled = true; clearTimeout(timer); reject(error)
    }
    processHandle.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (stdout.length > 4096) { processHandle.kill(); fail(new Error('Unexpectedly large child output')) }
    })
    processHandle.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096) })
    processHandle.once('error', fail)
    processHandle.once('close', code => {
      if (settled) return
      if (code !== 0) return fail(new Error(`Child ${mode} exited ${code}: ${stderr}`))
      try { const value = JSON.parse(stdout.trim()); settled = true; clearTimeout(timer); resolve(value) }
      catch (error) { fail(new Error(`Invalid child result: ${String(error)}`)) }
    })
  })
}

async function cleanupRace(root: string): Promise<void> {
  let now = Date.now()
  const store = new ToolOutputStore(root, { ttlMs: 1000, now: () => now })
  const originalRead = fs.readdir
  let release!: () => void; let enumerated!: () => void
  const enumeration = new Promise<void>(resolve => { enumerated = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  let intercepted = false
  try {
    const removed = await store.save('deleted-during-cleanup', 'deleted')
    const expired = await store.save('other-expired-session', 'expired')
    const active = await store.createWriter('active-session')
    await active.append('active first')
    now += 1100
    // Pause only the root enumeration, after it captured the soon-to-disappear directory.
    fs.readdir = (async (target: unknown, options?: unknown) => {
      const names = await Reflect.apply(originalRead, fs, [target, options]) as string[]
      if (String(target) === root && !intercepted) {
        intercepted = true
        names.sort((a, b) => Number(b === digest('deleted-during-cleanup')) - Number(a === digest('deleted-during-cleanup')))
        enumerated(); await resume
      }
      return names
    }) as typeof fs.readdir
    const cleaning = store.cleanup()
    try {
      await Promise.race([enumeration, cleaning.then(() => { throw new Error('Cleanup finished before the deterministic race checkpoint') })])
      await store.deleteSession('deleted-during-cleanup')
    } finally { release() }
    await cleaning
    fs.readdir = originalRead
    await assert.rejects(store.read('deleted-during-cleanup', removed), /unavailable/)
    await assert.rejects(store.read('other-expired-session', expired), /unavailable/)
    assert.deepEqual(await fs.readdir(directory(root, 'other-expired-session')), [],
      'a missing session encountered first does not cancel cleanup of other expired sessions')
    assert.equal((await fs.readdir(directory(root, 'active-session'))).filter(name => name.endsWith('.partial')).length, 1)
    await active.append(' and last')
    const live = await active.finish()
    assert.match(await store.read('active-session', live), /active first and last/,
      'cleanup never removes an active writer, even after the normal TTL elapses')
  } finally { release(); fs.readdir = originalRead; await store.dispose() }
}

async function sessionIsolation(root: string): Promise<void> {
  const store = new ToolOutputStore(root)
  try {
    const owned = await store.save('owner', 'DISK-OWNER-SECRET', { toolName: 'grep' })
    const foreign = await store.save('foreign', 'DISK-FOREIGN-SECRET')
    assert.deepEqual((await store.list('owner')).map(item => item.id), [owned])
    assert.deepEqual(await store.list('unrelated'), [])
    await assert.rejects(store.read('owner', foreign), /unavailable/)
    await assert.rejects(store.read('foreign', owned), /unavailable/)
    const messages = [
      { id: 'own-message', sessionId: 'owner', role: 'tool', content: 'HISTORY-OWNER-SECRET', timestamp: 1, toolName: 'bash' },
      { id: 'foreign-message', sessionId: 'foreign', role: 'tool', content: 'HISTORY-FOREIGN-SECRET', timestamp: 2, toolName: 'bash' }
    ] as UIMessage[]
    // Deliberately return both sessions; each adapter must still enforce its own session boundary.
    const source = { getMessages: () => messages }
    const lister = createToolOutputLister(store, source)
    const reader = createToolOutputReader(store, source)
    const ctx = { workspacePath: workspace, sessionId: 'owner' }
    const listed = normalizeToolOutput(await lister.execute({}, ctx))
    const parsed = JSON.parse(listed.content)
    assert.deepEqual(new Set(parsed.results.map((item: { output_id: string }) => item.output_id)), new Set([owned, 'message:own-message']))
    assert.doesNotMatch(listed.content, /FOREIGN|foreign-message/)
    const retained = normalizeToolOutput(await reader.execute({ output_id: 'message:own-message' }, ctx))
    assert.match(retained.content, /HISTORY-OWNER-SECRET/)
    assert.equal(retained.outputRef?.id, 'message:own-message')
    const forbidden = normalizeToolOutput(await reader.execute({ output_id: 'message:foreign-message' }, ctx))
    assert.equal(forbidden.isError, true)
    assert.doesNotMatch(forbidden.content, /HISTORY-FOREIGN-SECRET/)
    const forbiddenDisk = normalizeToolOutput(await reader.execute({ output_id: foreign }, ctx))
    assert.equal(forbiddenDisk.isError, true)
    const noSession = normalizeToolOutput(await lister.execute({}, { workspacePath: workspace }))
    assert.equal(noSession.isError, true)
  } finally { await store.dispose() }
}

if (process.argv[2] === '--child') {
  await child(process.argv[3], process.argv[4])
} else {
  const root = await fs.mkdtemp(path.join(workspace, '.test-output-lifecycle-'))
  try {
    const restart = path.join(root, 'restart')
    const saved = await runChild('save', restart)
    const restored = await runChild('read', restart)
    assert.equal(restored.id, saved.id)
    assert.equal(restored.hash, digest(text))
    assert.ok((restored.pages as number) > 30)
    const crash = path.join(root, 'crash')
    const crashed = await runChild('crash-write', crash)
    assert.equal((await fs.readdir(directory(crash, session))).filter(name => name.endsWith('.partial')).length, 1)
    const recovered = await runChild('crash-recover', crash)
    assert.equal(recovered.retained, crashed.id)
    await cleanupRace(path.join(root, 'cleanup-race'))
    await sessionIsolation(path.join(root, 'isolation'))
    console.log('Tool output lifecycle: real process restart, orphan recovery, quota release, cleanup/delete race, live writers and session discovery boundaries passed')
  } finally {
    assert.equal(path.dirname(root), workspace)
    assert.ok(path.basename(root).startsWith('.test-output-lifecycle-'))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
