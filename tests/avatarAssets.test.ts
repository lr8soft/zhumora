import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { AvatarAssetStore } from '../src/main/avatar/assetStore.ts'

const root = await mkdtemp(path.join(tmpdir(), 'zhumora-avatar-assets-'))
const source = await mkdtemp(path.join(tmpdir(), 'zhumora-avatar-source-'))
const managedRoot = path.join(root, 'managed')
const store = new AvatarAssetStore(managedRoot)

const write = async (name: string, bytes: string) => {
  const file = path.join(source, name)
  await writeFile(file, bytes)
  return file
}

// Multi-selection imports every file in one call and names each clip from its basename.
const hello = await write('004_hello_1.vrma', 'hello-bytes')
const idle = await write('CC0animationidle01.vrma', 'idle-bytes')
const imported = await store.importAnimations([hello, idle])
assert.equal(imported.length, 2, 'both files import in one batch')
assert.deepEqual(imported.map(a => a.name), ['004_hello_1', 'CC0animationidle01'])
assert.ok(imported.every(a => a.source === 'vrma'))
assert.ok(imported.every(a => existsSync(a.filePath!)), 'managed copies exist on disk')
assert.equal(new Set(imported.map(a => a.id)).size, 2, 'managed ids are unique')
assert.ok(imported.every(a => path.resolve(a.filePath!).startsWith(path.resolve(managedRoot))), 'copies stay inside the managed root')

// A rejected file must be skipped without discarding the rest of the batch.
const notes = await write('notes.txt', 'not an animation')
const good = await write('wave.vrma', 'wave-bytes')
const partial = await store.importAnimations([notes, good])
assert.deepEqual(partial.map(a => a.name), ['wave'], 'a bad file does not abort the batch')
assert.equal((await readdir(managedRoot)).length, 3, 'only the valid file was copied')

// Duplicate names stay distinct clips; enqueuing the same path twice must not collide ids.
const again = await store.importAnimations([good, good])
assert.equal(new Set(again.map(a => a.id)).size, 2, 're-importing the same file yields distinct ids')

// Cancel (empty selection) and out-of-root reads are handled explicitly.
assert.deepEqual(await store.importAnimations([]), [], 'an empty selection imports nothing')
assert.deepEqual(
  await store.importAnimations([path.join(source, 'missing.vrma')]), [],
  'an unreadable file is skipped, not thrown'
)
assert.ok((await store.readManagedFile(imported[0].filePath!)).byteLength > 0)
await assert.rejects(() => store.readManagedFile(hello), /outside the managed/, 'reads are confined to the managed root')

// Unreferenced files are pruned; referenced ones survive.
const before = { id: 'm', name: 'm', filePath: imported[1].filePath!, animations: [] }
const after = { id: 'm', name: 'm', filePath: imported[0].filePath!, animations: [] }
await store.removeUnreferenced([before], [after])
const leftovers = await readdir(managedRoot)
assert.ok(leftovers.includes(path.basename(after.filePath)), 'referenced assets are kept')
assert.ok(!leftovers.includes(path.basename(before.filePath)), 'unreferenced assets are removed')

await rm(root, { recursive: true, force: true })
await rm(source, { recursive: true, force: true })

console.log('avatar asset store batch import and boundary tests passed')
