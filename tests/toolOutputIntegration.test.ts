import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeShellCommand } from '../src/main/tools/shell.ts'
import { editFileExact, readPath } from '../src/main/tools/fileOperations.ts'
import { grepWithRipgrep, globWithRipgrep } from '../src/main/tools/ripgrep.ts'
import { MAX_TOOL_OUTPUT_CHARS } from '../src/main/tools/outputLimits.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhumora-output-'))
const command = (file: string) => `"${process.execPath}" "${path.join(root, file)}"`
try {
  await fs.writeFile(path.join(root, 'verbose.cjs'), `
    async function main() {
      const out = text => new Promise(resolve => process.stdout.write(text, resolve));
      await out('FIRST_BUILD_LINE\\n');
      for (let i = 0; i < 6000; i++) await out('log-' + i + ': ' + 'x'.repeat(250) + '\\n');
      await new Promise(resolve => process.stderr.write('FINAL_ERROR_MARKER\\n', resolve));
      process.exitCode = 7;
    }
    main();
  `)
  const verbose = await executeShellCommand({ workspacePath: root, command: command('verbose.cjs'), timeoutSeconds: 10 })
  assert.match(verbose, /FIRST_BUILD_LINE/); assert.match(verbose, /FINAL_ERROR_MARKER/)
  assert.match(verbose, /exit code: 7/); assert.match(verbose, /Output truncated/)
  assert.doesNotMatch(verbose, /log-3000:/)
  assert.ok(verbose.length <= MAX_TOOL_OUTPUT_CHARS + 100)
  assert.ok(verbose.split('\n').length <= 502)

  await fs.writeFile(path.join(root, 'unicode.cjs'), `
    async function main() {
      for (const byte of Buffer.from('START 汉字😀 END\\n')) {
        await new Promise(resolve => process.stdout.write(Buffer.from([byte]), resolve));
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    main();
  `)
  const unicode = await executeShellCommand({ workspacePath: root, command: command('unicode.cjs'), timeoutSeconds: 5 })
  assert.match(unicode, /START 汉字😀 END/); assert.doesNotMatch(unicode, /�/)

  await fs.writeFile(path.join(root, 'timeout.cjs'), `console.log('begin'); console.log('x'.repeat(2000000)); setTimeout(() => {}, 5000)`)
  const timed = await executeShellCommand({ workspacePath: root, command: command('timeout.cjs'), timeoutSeconds: 1 })
  assert.match(timed, /timed out after 1s/); assert.match(timed, /line truncated/)
  assert.ok(timed.length < 5000)
  const abort = new AbortController()
  const aborted = executeShellCommand({ workspacePath: root, command: command('timeout.cjs'), signal: abort.signal })
  setTimeout(() => abort.abort(), 150)
  await assert.rejects(aborted, /aborted/i)

  const listing = path.join(root, 'listing'); await fs.mkdir(listing)
  await Promise.all(Array.from({ length: 500 }, (_, index) => fs.writeFile(path.join(listing, `file-${String(index).padStart(5, '0')}-${'n'.repeat(170)}.txt`), 'match')))
  const names: string[] = []; let offset = 1; let pages = 0
  do {
    const page = await readPath(root, 'listing', offset, 2000)
    assert.ok(page.length <= MAX_TOOL_OUTPUT_CHARS)
    names.push(...page.split('\n').filter(line => line.startsWith('f ')))
    const next = /continue with offset=(\d+)/.exec(page)
    offset = next ? Number(next[1]) : 0
    assert.ok(++pages < 10, 'directory paging makes forward progress')
  } while (offset)
  assert.ok(pages > 1); assert.equal(names.length, 500); assert.equal(new Set(names).size, 500, 'paging neither skips nor duplicates names')
  const glob = await globWithRipgrep({ workspacePath: root, searchPath: 'listing', pattern: '**/*', limit: 2000 })
  assert.ok(glob.length <= MAX_TOOL_OUTPUT_CHARS); assert.match(glob, /Output truncated/)
  assert.match(glob, /Narrow the pattern/)

  const lines = Array.from({ length: 500 }, (_, index) => `MATCH-${index} ${'y'.repeat(1900)}`)
  await fs.writeFile(path.join(root, 'matches.txt'), lines.join('\n'))
  const grep = await grepWithRipgrep({ workspacePath: root, searchPath: 'matches.txt', pattern: 'MATCH', limit: 1000 })
  assert.ok(grep.length <= MAX_TOOL_OUTPUT_CHARS); assert.match(grep, /MATCH-0 /); assert.match(grep, /MATCH-499 /)
  assert.match(grep, /Output truncated/)
  await fs.writeFile(path.join(root, 'edit.txt'), 'before')
  const replacement = 'x'.repeat(1_000_000)
  const edited = await editFileExact(root, 'edit.txt', 'before', replacement)
  assert.ok(edited.length < 5000, 'edit previews also bound a giant replacement line')
  assert.match(edited, /line truncated/)
  assert.equal(await fs.readFile(path.join(root, 'edit.txt'), 'utf8'), replacement, 'preview limits do not truncate file writes')
  console.log('Tool output integration: >1MiB command tail/errors, exit metadata, Unicode chunks, timeout/abort, directory paging and search/glob caps passed')
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('zhumora-output-'))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
