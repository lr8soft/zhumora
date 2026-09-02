import { DesktopFrameStore } from '../src/main/desktop/frameStore.ts'
import { screenshotPointToScreen } from '../src/main/desktop/coordinates.ts'
import {
  TerminatorProcessAdapter,
  type DesktopWorkerProcess
} from '../src/main/desktop/processAdapter.ts'
import type { DesktopProcessRequest } from '../src/main/desktop/processProtocol.ts'

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

async function asyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn()
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

class FakeDesktopWorker implements DesktopWorkerProcess {
  readonly pid: number
  killCount = 0
  private messageListeners: Array<(message: unknown) => void> = []
  private readonly alwaysHang: boolean

  constructor(pid: number, alwaysHang = false) {
    this.pid = pid
    this.alwaysHang = alwaysHang
  }

  postMessage(message: DesktopProcessRequest): void {
    if (this.alwaysHang || this.pid === 1) return
    queueMicrotask(() => {
      for (const listener of this.messageListeners) {
        listener({
          id: message.id,
          ok: true,
          value: {
            backend: 'fake',
            platform: 'win32',
            frameId: 'recovered-frame',
            monitors: []
          }
        })
      }
    })
  }

  kill(): boolean {
    this.killCount += 1
    return true
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListeners.push(listener)
  }

  onExit(_listener: (code: number) => void): void {}

  onError(_listener: (description: string) => void): void {}
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

await asyncTest('stuck Terminator process is killed and the next call uses a fresh process', async () => {
  const workers: FakeDesktopWorker[] = []
  const adapter = new TerminatorProcessAdapter(() => {
    const worker = new FakeDesktopWorker(workers.length + 1)
    workers.push(worker)
    return worker
  }, { observeTimeoutMs: 20 })

  let timeoutMessage = ''
  try {
    await adapter.observe({ mode: 'applications' })
  } catch (error) {
    timeoutMessage = (error as Error).message
  }
  if (!timeoutMessage.includes('[DESKTOP_TIMEOUT]')) throw new Error(`unexpected error: ${timeoutMessage}`)
  assertEqual(workers.length, 1)
  assertEqual(workers[0].killCount, 1)

  const observation = await adapter.observe({ mode: 'applications' })
  assertEqual(workers.length, 2)
  assertEqual(observation.frameId, 'recovered-frame')
  await adapter.dispose()
})

await asyncTest('cancelling a desktop call kills its isolated process immediately', async () => {
  const worker = new FakeDesktopWorker(1, true)
  const adapter = new TerminatorProcessAdapter(() => worker, { observeTimeoutMs: 10_000 })
  const controller = new AbortController()
  const pending = adapter.observe({ mode: 'applications' }, controller.signal)
  await Promise.resolve()
  controller.abort()

  let abortName = ''
  try {
    await pending
  } catch (error) {
    abortName = (error as Error).name
  }
  assertEqual(abortName, 'AbortError')
  assertEqual(worker.killCount, 1)
  await adapter.dispose()
})

await asyncTest('disposing during a stuck call settles the call and shutdown', async () => {
  const worker = new FakeDesktopWorker(1, true)
  const adapter = new TerminatorProcessAdapter(() => worker, { observeTimeoutMs: 10_000 })
  const pending = adapter.observe({ mode: 'window', process: 'stuck.exe' }).catch(error => error as Error)
  await Promise.resolve()

  await adapter.dispose()
  const error = await pending
  if (!error.message.includes('[DESKTOP_DISPOSED]')) throw new Error(`unexpected error: ${error.message}`)
  assertEqual(worker.killCount, 1)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
