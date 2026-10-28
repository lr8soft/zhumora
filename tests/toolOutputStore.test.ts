import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ToolOutputStore } from '../src/main/tools/toolOutputStore.ts'
import { createToolOutputReader } from '../src/main/tools/toolOutputReader.ts'
import { MAX_TOOL_OUTPUT_CHARS, MAX_TOOL_OUTPUT_LINES } from '../src/main/tools/outputLimits.ts'

// Windows app-container temp paths can reject rename of these nested artifacts.
const root = await fs.mkdtemp(path.join(process.cwd(), '.test-output-store-'))
const sessionDirectory = (session: string, base = root) => path.join(base, createHash('sha256').update(session).digest('hex'))
const cursor = (page: string) => {
  const match = /next_offset=(\d+) next_char_offset=(\d+)/.exec(page)
  return match ? { offset: Number(match[1]), char_offset: Number(match[2]) } : null
}
const bodyLines = (page: string) => page.split('\n').filter(line => /^\d+(?::\d+)?: /.test(line))
let store = new ToolOutputStore(root)
try {
  const text = Array.from({ length: 451 }, (_, index) => `original-${index + 1}`).join('\n')
  const id = await store.save('session-a', text)
  await assert.rejects(() => store.read('session-b', id), /unavailable/)
  await assert.rejects(() => store.read('session-a', '../anything'), /Invalid output_id/)
  await assert.rejects(() => store.save('', 'text'), /sessionId/)
  await store.dispose()
  store = new ToolOutputStore(root)
  const received: string[] = []
  let next: { offset: number; char_offset: number } | null = { offset: 1, char_offset: 0 }
  while (next) {
    const page = await store.read('session-a', id, { ...next, limit: 37 })
    assert.ok(page.length <= MAX_TOOL_OUTPUT_CHARS)
    assert.ok(page.split('\n').length <= MAX_TOOL_OUTPUT_LINES)
    received.push(...bodyLines(page).map(line => line.replace(/^\d+(?::\d+)?: /, '')))
    next = cursor(page)
  }
  assert.equal(received.join('\n'), text, 'pages neither skip nor duplicate original lines')

  const longText = `${'😀中'.repeat(2300)} LAST\nsecond line`
  const longId = await store.save('session-a', longText)
  const fragments: string[] = []
  next = { offset: 1, char_offset: 0 }
  while (next) {
    const page = await store.read('session-a', longId, next)
    assert.doesNotMatch(page, /�/)
    for (const line of bodyLines(page)) {
      assert.ok(line.length <= 2000)
      const match = /^(\d+)(?::\d+)?: (.*)$/.exec(line)!
      if (match[1] === '1') fragments.push(match[2])
    }
    next = cursor(page)
  }
  assert.equal(fragments.join(''), longText.split('\n')[0], 'long lines are fully retrievable with Unicode-safe cursors')
  const matchingLongId = await store.save('session-a', `${'x'.repeat(6500)}NEEDLE\nnot matching\nNEEDLE again`)
  let matchedText = ''; next = { offset: 1, char_offset: 0 }
  while (next) {
    const page = await store.read('session-a', matchingLongId, { ...next, pattern: 'NEEDLE' })
    matchedText += bodyLines(page).map(line => line.replace(/^\d+(?::\d+)?: /, '')).join('')
    next = cursor(page)
  }
  assert.equal(matchedText, `${'x'.repeat(6500)}NEEDLENEEDLE again`, 'matching long-line tails stay accessible')
  const blanksId = await store.save('session-a', '\nfirst\n\nlast\n')
  const blankLines: string[] = []; next = { offset: 1, char_offset: 0 }
  while (next) {
    const page = await store.read('session-a', blanksId, { ...next, limit: 1 })
    blankLines.push(...bodyLines(page).map(line => line.replace(/^\d+(?::\d+)?: /, '')))
    next = cursor(page)
  }
  assert.deepEqual(blankLines, ['', 'first', '', 'last'])
  const searched = await store.read('session-a', id, { pattern: 'original-4', limit: 2 })
  assert.match(searched, /4: original-4\n40: original-40/)
  const searchedNext = await store.read('session-a', id, { pattern: 'original-4', limit: 2, ...cursor(searched)! })
  assert.match(searchedNext, /41: original-41\n42: original-42/)
  assert.match(await store.read('session-a', id, { pattern: '.*' }), /no matching lines/)
  await assert.rejects(() => store.read('session-a', id, { offset: 0 }), /integer/)
  await assert.rejects(() => store.read('session-a', id, { offset: 900 }), /beyond/)
  const reader = createToolOutputReader(store)
  assert.equal(reader.permission, 'safe')
  assert.deepEqual(await reader.execute({ output_id: id }, { workspacePath: root }), {
    content: 'A session is required to read tool output', isError: true
  })
  const denied = await reader.execute({ output_id: id }, { workspacePath: root, sessionId: 'session-b' })
  assert.equal(typeof denied === 'string' ? false : denied.isError, true)

  const stream = await store.createWriter('session-a')
  await Promise.all([stream.append('first\n'), stream.append('\uD83D'), stream.append('\uDE00 tail')])
  const streamedId = await stream.finish()
  assert.match(await store.read('session-a', streamedId), /first\n2: 😀 tail/)
  assert.equal(await stream.finish(), streamedId)
  await assert.rejects(() => stream.append('late'), /closed/)
  const cancelled = new AbortController()
  const abandoned = await store.createWriter('abandoned', cancelled.signal)
  await abandoned.append('partial')
  cancelled.abort()
  await assert.rejects(() => abandoned.finish(), /abort/i)
  assert.deepEqual(await fs.readdir(sessionDirectory('abandoned')), [])
  const abortedRead = new AbortController(); abortedRead.abort()
  await assert.rejects(() => store.read('session-a', id, { signal: abortedRead.signal }), /abort/i)

  const quotaRoot = path.join(root, 'quotas')
  const quota = new ToolOutputStore(quotaRoot, { maxResultBytes: 10, maxSessionBytes: 15 })
  const quotaId = await quota.save('q', '1234567890')
  await assert.rejects(() => quota.save('q', 'abcdef'), /session storage quota/)
  await assert.rejects(() => quota.save('q2', '12345678901'), /per-result storage quota/)
  const firstWriter = await quota.createWriter('parallel')
  const secondWriter = await quota.createWriter('parallel')
  await firstWriter.append('1234567890')
  await assert.rejects(() => secondWriter.append('123456'), /session storage quota/)
  await firstWriter.discard()
  assert.deepEqual(await fs.readdir(sessionDirectory('parallel', quotaRoot)), [])
  const quotaWriters = await Promise.all([quota.createWriter('concurrent'), quota.createWriter('concurrent')])
  const concurrent = await Promise.allSettled(quotaWriters.map(writer => writer.append('12345678')))
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1, 'concurrent reservations cannot exceed session quota')
  await Promise.all(quotaWriters.map(writer => writer.discard()))
  assert.match(await quota.read('q', quotaId), /1234567890/)
  await quota.deleteSession('q')
  await assert.rejects(() => quota.read('q', quotaId), /unavailable/)
  await quota.dispose()

  let now = Date.now()
  const expiryRoot = path.join(root, 'expiry')
  const expiry = new ToolOutputStore(expiryRoot, { ttlMs: 1000, now: () => now })
  const old = await expiry.save('ttl', 'saved')
  const activeWriter = await expiry.createWriter('ttl')
  await activeWriter.append('active')
  const orphanPath = path.join(sessionDirectory('ttl', expiryRoot), `${randomUUID()}.partial`)
  await fs.writeFile(orphanPath, 'orphan')
  await fs.utimes(orphanPath, new Date(now - 2000), new Date(now - 2000))
  now += 1100
  await assert.rejects(() => expiry.read('ttl', old), /expired/)
  await expiry.cleanup()
  assert.equal((await fs.readdir(sessionDirectory('ttl', expiryRoot))).length, 1, 'cleanup preserves only the active writer')
  const recent = await activeWriter.finish()
  assert.match(await expiry.read('ttl', recent), /active/)
  const unfinished = await expiry.createWriter('ttl')
  await unfinished.append('unfinished')
  await expiry.dispose()
  await assert.rejects(() => unfinished.append('late'), /closed/)
  await assert.rejects(() => expiry.save('ttl', 'late'), /disposed/)
  const invalidRoot = path.join(root, 'not-a-directory')
  await fs.writeFile(invalidRoot, '')
  const invalid = new ToolOutputStore(invalidRoot)
  await assert.rejects(() => invalid.createWriter('s'))
  await invalid.dispose()
  const racing = new ToolOutputStore(path.join(root, 'races'))
  const opening = racing.createWriter('deleting')
  const deleting = racing.deleteSession('deleting')
  await assert.rejects(() => opening, /being deleted/)
  await assert.rejects(() => racing.createWriter('deleting'), /being deleted/)
  await deleting
  const activeDuringDelete = await racing.createWriter('active-delete')
  await activeDuringDelete.append('partial')
  await Promise.all([racing.deleteSession('active-delete'), racing.deleteSession('active-delete')])
  await assert.rejects(() => activeDuringDelete.finish(), /closed/)
  const saveWhileDisposing = racing.save('dispose-race', 'text')
  const disposing = racing.dispose()
  await assert.rejects(() => saveWhileDisposing, /disposed/)
  await disposing
  console.log('Tool output store: session isolation, restart, Unicode paging, search, quotas, TTL, cancellation and cleanup passed')
} finally {
  await store.dispose()
  assert.equal(path.dirname(path.resolve(root)), path.resolve(process.cwd()))
  assert.ok(path.basename(root).startsWith('.test-output-store-'))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
