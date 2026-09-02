import { DesktopFrameStore } from '../src/main/desktop/frameStore.ts'
import { screenshotPointToScreen } from '../src/main/desktop/coordinates.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(`    ${(error as Error).message}`)
  }
}

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

console.log('\ndesktop adapters')

test('frame store creates resolvable target references', () => {
  const store = new DesktopFrameStore(2, 1000, () => 100)
  const frame = store.createFrame('notepad.exe', 'Notes', {
    '1': {
      role: 'Button',
      name: 'Save',
      selector: 'role:Button&&name:Save',
      bounds: { x: 10, y: 20, width: 30, height: 40 }
    }
  }, 10)
  assertEqual(frame.targets.length, 1)
  assertEqual(store.resolve(frame.targets[0].ref).process, 'notepad.exe')
  assertEqual(store.resolve(frame.targets[0].ref).selector, 'role:Button&&name:Save')
})

test('frame store expires stale references', () => {
  let now = 100
  const store = new DesktopFrameStore(2, 1000, () => now)
  const frame = store.createFrame('notepad.exe', undefined, {
    '1': { role: 'Edit', name: 'Text', bounds: { x: 0, y: 0, width: 100, height: 40 } }
  }, 10)
  now = 1200
  let message = ''
  try {
    store.resolve(frame.targets[0].ref)
  } catch (error) {
    message = (error as Error).message
  }
  if (!message.includes('[STALE_REF]')) throw new Error(`unexpected error: ${message}`)
})

test('screenshot coordinates map to a negative-origin physical display', () => {
  const frame = {
    frameId: 'frame-1',
    imageWidth: 1280,
    imageHeight: 720,
    screenBounds: { x: -1920, y: 290, width: 1920, height: 1080 }
  }
  const center = screenshotPointToScreen(frame, 640, 360)
  assertEqual(center.x, -960)
  assertEqual(center.y, 830)
  const bottomRight = screenshotPointToScreen(frame, 1280, 720)
  assertEqual(bottomRight.x, 0)
  assertEqual(bottomRight.y, 1370)
})

test('screenshot coordinate validation rejects out-of-frame points', () => {
  let message = ''
  try {
    screenshotPointToScreen({
      frameId: 'frame-1',
      imageWidth: 100,
      imageHeight: 100,
      screenBounds: { x: 0, y: 0, width: 200, height: 200 }
    }, 101, 50)
  } catch (error) {
    message = (error as Error).message
  }
  if (!message.includes('[INVALID_COORDINATES]')) throw new Error(`unexpected error: ${message}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
