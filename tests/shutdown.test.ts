import assert from 'node:assert/strict'
import { ApplicationShutdown } from '../src/main/shutdown.ts'

let release!: () => void
let prevented = 0; let quit = 0; let begin = 0
const sequence: string[] = []; const errors: string[] = []
const event = { preventDefault: () => { prevented++ } }
const shutdown = new ApplicationShutdown({ begin: () => { begin++ }, quit: () => { quit++ }, report: text => errors.push(text), steps: [
  { name: 'sessions', run: () => new Promise<void>(resolve => { release = resolve; sequence.push('sessions') }) },
  { name: 'writers', run: () => { sequence.push('writers') } },
  { name: 'failure', run: () => { throw new Error('dispose failure') } },
  { name: 'stalled', run: () => new Promise(() => {}), timeoutMs: 15 },
  { name: 'database', run: () => { sequence.push('database') } }
] })
shutdown.beforeQuit(event); shutdown.beforeQuit(event)
await new Promise(resolve => setImmediate(resolve))
assert.equal(prevented, 2); assert.equal(begin, 1); assert.equal(quit, 0)
assert.deepEqual(sequence, ['sessions'], 'writers/database must wait until session stop settles')
release()
await new Promise(resolve => setTimeout(resolve, 40))
assert.deepEqual(sequence, ['sessions', 'writers', 'database'])
assert.equal(errors.length, 2); assert.equal(quit, 1)
shutdown.beforeQuit(event)
assert.equal(prevented, 2, 'the final quit reentry is allowed without starting cleanup again')
console.log('Shutdown: quit prevention, ordered cleanup, reentry, failures and bounded waits passed')
