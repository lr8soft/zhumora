import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { editFileExact, readPath, writeFilePreservingBom } from '../src/main/tools/fileOperations.ts'
import { globWithRipgrep, grepWithRipgrep } from '../src/main/tools/ripgrep.ts'
import { executeShellCommand } from '../src/main/tools/shell.ts'
import { findBundledChromium } from '../src/main/tools/browserRuntime.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhumora-tools-'))
try {
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, 'src', 'alpha.ts'), 'const alpha = 1\r\nconst target = alpha\r\n')
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n')
  await fs.mkdir(path.join(root, 'ignored'))
  await fs.writeFile(path.join(root, 'ignored', 'secret.ts'), 'const target = "ignored"\n')

  const read = await readPath(root, 'src/alpha.ts')
  assert.match(read, /1: const alpha = 1/)
  assert.match(read, /2: const target = alpha/)

  const listing = await readPath(root, '.')
  assert.ok(listing.indexOf('d src/') < listing.indexOf('f .gitignore'))

  const bomFile = path.join(root, 'src', 'bom.ts')
  await fs.writeFile(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')]))
  await editFileExact(root, 'src/bom.ts', 'one\ntwo', 'ONE\nTWO')
  let bomResult = await fs.readFile(bomFile)
  assert.deepEqual([...bomResult.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.match(bomResult.toString('utf8'), /ONE\r\nTWO\r\n/)

  await writeFilePreservingBom(root, 'src/bom.ts', 'rewritten')
  bomResult = await fs.readFile(bomFile)
  assert.deepEqual([...bomResult.subarray(0, 3)], [0xef, 0xbb, 0xbf])

  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  await assert.rejects(() => readPath(root, 'binary.bin'), /binary file/)

  const grep = await grepWithRipgrep({ workspacePath: root, pattern: 'target', include: '*.ts' })
  assert.match(grep, /src\/alpha\.ts:2:/)
  assert.doesNotMatch(grep, /ignored/)

  const glob = await globWithRipgrep({ workspacePath: root, pattern: '**/*.ts' })
  assert.match(glob, /src\/alpha\.ts/)
  assert.doesNotMatch(glob, /ignored/)

  const command = process.platform === 'win32' ? 'echo shell-ok' : "printf 'shell-ok'"
  const shell = await executeShellCommand({ workspacePath: root, command, timeoutSeconds: 5 })
  assert.match(shell, /shell-ok/)
  assert.match(shell, /exit code: 0/)

  const browserRoot = path.join(root, 'browsers', 'chromium-123', 'chrome-win64')
  await fs.mkdir(browserRoot, { recursive: true })
  const fakeChrome = path.join(browserRoot, 'chrome.exe')
  await fs.writeFile(fakeChrome, '')
  assert.equal(findBundledChromium(path.join(root, 'browsers'), 'win32'), fakeChrome)

  const macChrome = path.join(root, 'mac-browsers', 'chromium-123', 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
  await fs.mkdir(path.dirname(macChrome), { recursive: true })
  await fs.writeFile(macChrome, '')
  assert.equal(findBundledChromium(path.join(root, 'mac-browsers'), 'darwin'), macChrome)

  const linuxChrome = path.join(root, 'linux-browsers', 'chromium-123', 'chrome-linux64', 'chrome')
  await fs.mkdir(path.dirname(linuxChrome), { recursive: true })
  await fs.writeFile(linuxChrome, '')
  assert.equal(findBundledChromium(path.join(root, 'linux-browsers'), 'linux'), linuxChrome)

  console.log('builtinTools tests passed')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
