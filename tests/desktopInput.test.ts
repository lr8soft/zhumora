import assert from 'node:assert/strict'
import { encodeKeyboardInput } from '../src/main/desktop/keyboard.ts'
import { DesktopControlCoordinator } from '../src/main/desktop/controlCoordinator.ts'
import { createDesktopInputTools, desktopAfterAction } from '../src/main/tools/desktopInput.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'

for (const key of ['ArrowDown', 'DOWN', 'arrow_down']) {
  assert.deepEqual(encodeKeyboardInput(key), { sequence: '{DOWN}', repeat: 1 })
}
assert.equal(encodeKeyboardInput('CTRL+S').sequence, '{CTRL}s')
assert.equal(encodeKeyboardInput('Delete', ['Ctrl', 'Alt']).sequence, '{CTRL}{ALT}{DELETE}')
assert.equal(encodeKeyboardInput('ArrowLeft', ['Shift'], 3).sequence, '{SHIFT}{LEFT}')
assert.equal(encodeKeyboardInput('F24').sequence, '{F24}')
for (const key of ['{CTRL}a', 'hello', 'Ctrl', 'Ctrl+', 'F25']) assert.throws(() => encodeKeyboardInput(key))
for (const repeat of [0, 21, 1.5, '3', NaN]) assert.throws(() => encodeKeyboardInput('Enter', [], repeat))
assert.throws(() => encodeKeyboardInput('Enter', 'Ctrl'))
assert.throws(() => encodeKeyboardInput('Enter', ['unknown']))
assert.equal(desktopAfterAction('move'), 'none')
assert.equal(desktopAfterAction('click'), 'screenshot')
assert.equal(desktopAfterAction('move', 'observe'), 'observe')

let visible = false
let disposed = false
const control = new DesktopControlCoordinator({
  async show() { visible = true }, hide() { visible = false }, dispose() { disposed = true }
})
let count = 0
await control.run('a', undefined, async () => { count++; assert.equal(visible, true) })
await assert.rejects(control.run('b', undefined, async () => { count++ }), /DESKTOP_BUSY/)
assert.equal(count, 1)
control.release('b')
assert.equal(visible, true)
control.release('a')
assert.equal(visible, false)
await assert.rejects(control.run('b', undefined, async () => { throw new Error('native failure') }), /native failure/)
assert.equal(visible, false)
const abort = new AbortController()
let finish!: () => void
const pending = control.run('a', abort.signal, () => new Promise<void>(resolve => { finish = resolve }))
await Promise.resolve()
abort.abort()
assert.equal(visible, false)
await assert.rejects(control.run('b', undefined, async () => {}), /DESKTOP_BUSY/)
finish()
await pending
await control.run('b', undefined, async () => {})
control.release('b')
await assert.rejects(control.run('a', abort.signal, async () => { count++ }), /DESKTOP_ABORTED/)
assert.equal(count, 1)
control.dispose()
assert.equal(disposed, true)
assert.equal(visible, false)
await assert.rejects(control.run('a', undefined, async () => {}), /DESKTOP_ABORTED/)
console.log('Desktop keyboard and control ownership tests passed.')

const inputControl = new DesktopControlCoordinator({ async show() {}, hide() {}, dispose() {} })
const calls: Record<string, unknown>[] = []
const registry = new ToolRegistry()
registry.register('unrelated', { definition: { type: 'function', function: { name: 'unrelated', description: '', parameters: {} } }, async execute() { return { content: 'ok' } } })
for (const { name, handler } of createDesktopInputTools(async args => { calls.push(args); return 'ok' }, inputControl)) registry.register(name, handler)
assert.equal(registry.definitions().length, 5)
assert.ok(registry.get('unrelated'))
const ctx = { workspacePath: '.', sessionId: 'test' }
const keyTool = registry.get('desktop_key')!.handler
assert.equal(keyTool.permission, 'dangerous')
assert.deepEqual(await keyTool.execute({ key: 'ArrowDown', repeat: 3 }, ctx), { content: 'ok' })
assert.equal(calls[0].action, 'key')
const mouse = registry.get('desktop_mouse')!.handler
const invalid = await mouse.execute({ action: 'drag', x: 1, y: 2 }, ctx)
assert.equal(typeof invalid !== 'string' && invalid.isError, true)
assert.equal(calls.length, 1)
await mouse.execute({ action: 'drag', x: 1, y: 2, end_x: 4, end_y: 5 }, ctx)
assert.equal(calls[1].end_x, 4)
await mouse.execute({ action: 'move', target_ref: 'frame:u1', duration_ms: 180, easing: 'ease_out', anchor: 'left' }, ctx)
assert.equal(calls[2].duration_ms, 180)
assert.equal(calls[2].anchor, 'left')
const invalidDuration = await mouse.execute({ action: 'click', x: 1, y: 2, duration_ms: 100 }, ctx)
assert.equal(typeof invalidDuration !== 'string' && invalidDuration.isError, true)
const invalidAnchor = await mouse.execute({ action: 'move', x: 1, y: 2, anchor: 'left' }, ctx)
assert.equal(typeof invalidAnchor !== 'string' && invalidAnchor.isError, true)
assert.equal(calls.length, 3)
const legacy = registry.get('desktop_action')!.handler
await legacy.execute({ action: 'key', key: 'CTRL+S' }, ctx)
assert.equal(calls[3].key, 'CTRL+S')
inputControl.dispose()
console.log('Desktop tool routing and boundary validation tests passed.')
