import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { readPath } from '../src/main/tools/fileOperations.ts'
import { grepWithRipgrep, globWithRipgrep } from '../src/main/tools/ripgrep.ts'
import { browserTextPreview, MAX_TOOL_OUTPUT_CHARS } from '../src/main/tools/outputLimits.ts'
import { recoverableToolOutput } from '../src/main/tools/recoverableOutput.ts'
import { ToolOutputStore } from '../src/main/tools/toolOutputStore.ts'
import { readBrowserText } from '../src/main/tools/browserText.ts'

// The Windows execution sandbox denies rename in its redirected TEMP tree.
const workspace = path.resolve(import.meta.dirname, '..')
const root = await fs.mkdtemp(path.join(workspace, '.test-output-recovery-'))
const store = new ToolOutputStore(path.join(root, 'outputs'))
const context = { workspacePath: root, sessionId: 'recovery-session', outputStore: store }

try {
  const small = await recoverableToolOutput('small result', context, 'Read more if necessary.')
  assert.deepEqual(small, { content: 'small result' }, 'complete small results do not create an output reference')
  await assert.rejects(fs.stat(path.join(root, 'outputs')), { code: 'ENOENT' })

  const pageText = Array.from({ length: 3000 }, (_, index) => `PAGE-${index}: actual page content`).join('\n')
  const browser = await recoverableToolOutput(pageText, context, 'Read the saved page.', undefined, browserTextPreview(pageText, 5000))
  assert.ok(browser.outputRef)
  assert.ok(browser.content.length <= MAX_TOOL_OUTPUT_CHARS)
  assert.doesNotMatch(browser.content, /PAGE-1500:/)
  assert.match(browser.content, /read_tool_output/)
  assert.match(await store.read(context.sessionId, browser.outputRef.id, { pattern: 'PAGE-1500:' }), /PAGE-1500:/,
    'browser snapshots retain text omitted by the requested preview length')
  let currentPage = pageText
  const getPage = (async () => ({ locator: (selector: string) => {
    assert.equal(selector, '#article')
    return { first: () => ({ innerText: async () => currentPage, innerHTML: async () => `<main>${currentPage}</main>` }) }
  } })) as unknown as Parameters<typeof readBrowserText>[2]
  const actualText = await readBrowserText({ selector: '#article', max_length: 1000 }, context, getPage)
  const actualHtml = await readBrowserText({ selector: '#article', max_length: 1000 }, context, getPage, true)
  assert.ok(actualText.outputRef); assert.ok(actualHtml.outputRef)
  currentPage = 'navigated elsewhere'
  assert.match(await store.read(context.sessionId, actualText.outputRef.id, { pattern: 'PAGE-1500:' }), /PAGE-1500:/)
  assert.match(await store.read(context.sessionId, actualHtml.outputRef.id), /<main>/)
  await assert.rejects(store.read('another-session', browser.outputRef.id), /unavailable|expired/)

  const lines = Array.from({ length: 350 }, (_, index) => `MATCH-${String(index).padStart(3, '0')} content`)
  await fs.writeFile(path.join(root, 'matches.txt'), lines.join('\n'))
  const grep = await grepWithRipgrep({ workspacePath: root, searchPath: 'matches.txt', pattern: 'MATCH', limit: 3, context })
  assert.ok(grep.outputRef)
  assert.doesNotMatch(grep.content, /MATCH-200/)
  assert.match(await store.read(context.sessionId, grep.outputRef.id, { pattern: 'MATCH-200' }), /matches.txt:201: MATCH-200/,
    'match limits constrain the preview, while later matches remain available')

  const wide = 'MATCH ' + 'x'.repeat(70_000) + 'RECOVER_WIDE_LINE' + 'x'.repeat(9000)
  await fs.writeFile(path.join(root, 'wide.txt'), wide)
  const longMatch = await grepWithRipgrep({ workspacePath: root, searchPath: 'wide.txt', pattern: 'MATCH', context })
  assert.ok(longMatch.outputRef)
  assert.match(await store.read(context.sessionId, longMatch.outputRef.id, { char_offset: 69_500, limit: 1 }), /RECOVER_WIDE_LINE/,
    'a ripgrep JSON record larger than 64 KiB is retained with its complete matched line')

  await fs.mkdir(path.join(root, 'listing'))
  await Promise.all(Array.from({ length: 150 }, (_, index) => fs.writeFile(path.join(root, 'listing', `file-${String(index).padStart(3, '0')}.txt`), '')))
  const glob = await globWithRipgrep({ workspacePath: root, searchPath: 'listing', pattern: '*.txt', limit: 3, context })
  assert.ok(glob.outputRef)
  assert.match(await store.read(context.sessionId, glob.outputRef.id, { pattern: 'file-120.txt' }), /file-120.txt/,
    'file discovery preserves filenames beyond its preview limit')

  const original = 'a'.repeat(1999) + '😀汉字'.repeat(40_000) + 'LONG_FILE_END'
  await fs.writeFile(path.join(root, 'minified.txt'), original)
  let charOffset = 0
  let recovered = ''
  for (let page = 0; page < 1000; page++) {
    const result = await readPath(root, 'minified.txt', 1, 1, undefined, charOffset)
    assert.ok(result.isWellFormed(), 'line windows preserve surrogate pairs')
    const line = result.split('\n')[0].replace(/^\s*1: /, '')
    recovered += line.replace(/… \[line truncated;.*$/, '')
    const continuation = /char_offset=(\d+)/.exec(line)
    if (!continuation) break
    const next = Number(continuation[1])
    assert.ok(next > charOffset, 'character paging makes forward progress')
    charOffset = next
  }
  assert.equal(recovered, original, 'native file reads can recover every character of a minified line')
  const normalizedPair = await readPath(root, 'minified.txt', 1, 1, undefined, 2000)
  assert.ok(normalizedPair.isWellFormed())
  assert.match(normalizedPair, /1: 😀/)
  await assert.rejects(readPath(root, 'minified.txt', 1, 1, undefined, -1), /char_offset/)
  await assert.rejects(readPath(root, 'minified.txt', 1, 1, undefined, original.length + 1), /beyond line/)

  await fs.writeFile(path.join(root, 'capture.txt'), ('CAPTURE_MATCH ' + 'z'.repeat(1000) + '\n').repeat(10_000))
  const capped = await grepWithRipgrep({ workspacePath: root, searchPath: 'capture.txt', pattern: 'CAPTURE_MATCH', limit: 2, context })
  assert.equal(capped.isError, true, 'resource exhaustion is distinct from a complete query with a short preview')
  assert.match(capped.content, /capture limit reached.*results are incomplete/i)
  assert.ok(capped.outputRef)

  const abort = new AbortController(); abort.abort()
  await assert.rejects(recoverableToolOutput(pageText, { ...context, signal: abort.signal }, 'Read more.'), /aborted/)
  const failedStorage = { save: async () => { throw new Error('quota reached') } } as unknown as ToolOutputStore
  const readable = await recoverableToolOutput(pageText, { ...context, outputStore: failedStorage }, 'Read more.')
  assert.equal(readable.isError, undefined)
  assert.equal(readable.outputRef, undefined)
  assert.match(readable.content, /Full output could not be saved.*quota reached/)
  assert.doesNotMatch(readable.content, /Full output saved/)
  console.log('Tool output recovery: saved browser/search snapshots, later matches/files, wide JSON records, character paging and explicit capture exhaustion passed')
} finally {
  await store.dispose()
  assert.equal(path.dirname(path.resolve(root)), workspace)
  assert.ok(path.basename(root).startsWith('.test-output-recovery-'))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
