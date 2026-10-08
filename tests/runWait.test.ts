import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { AgentAbortedError } from '../src/shared/types.ts'
import { awaitWithSignal, waitUntilDeadline } from '../src/main/agent/runWait.ts'

{
  const controller = new AbortController(); let release!: (value: string) => void
  const waiting = awaitWithSignal(new Promise<string>(resolve => { release = resolve }), controller.signal)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  release('ready'); assert.equal(await waiting, 'ready')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
}
{
  const controller = new AbortController(); let rejectLate!: (error: Error) => void
  const waiting = awaitWithSignal(new Promise<never>((_, reject) => { rejectLate = reject }), controller.signal)
  controller.abort(); await assert.rejects(waiting, AgentAbortedError)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  rejectLate(new Error('late preparation failure'))
  await new Promise<void>(resolve => setImmediate(resolve))
}
{
  const controller = new AbortController(); controller.abort()
  await assert.rejects(awaitWithSignal(Promise.reject(new Error('already failed')), controller.signal), AgentAbortedError)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
}
{
  const controller = new AbortController(); const pending = new Promise<void>(() => {})
  assert.equal(await waitUntilDeadline(pending, Date.now(), controller.signal), false)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(await waitUntilDeadline(pending, Date.now() + 10, controller.signal), false)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const waiting = waitUntilDeadline(pending, Date.now() + 60000, controller.signal)
  controller.abort(); await assert.rejects(waiting, AgentAbortedError)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
}

console.log('Run wait cancellation, shared deadline and listener cleanup tests passed')
