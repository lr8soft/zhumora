import { WindowsTerminatorAdapter } from './windowsTerminatorAdapter'
import {
  isDesktopProcessRequest,
  type DesktopProcessRequest,
  type DesktopProcessResponse,
  type SerializedDesktopError
} from './processProtocol.ts'

const parentPort = process.parentPort
if (!parentPort) throw new Error('Terminator worker must run as an Electron utility process.')

let adapterPromise: ReturnType<typeof WindowsTerminatorAdapter.create> | undefined
let operationQueue: Promise<void> = Promise.resolve()

parentPort.on('message', event => {
  const request = event.data
  if (!isDesktopProcessRequest(request)) return
  operationQueue = operationQueue.then(
    () => handleRequest(request),
    () => handleRequest(request)
  )
})

async function handleRequest(request: DesktopProcessRequest): Promise<void> {
  try {
    const adapter = await getAdapter()
    const value = request.method === 'observe'
      ? await adapter.observe(request.payload)
      : await adapter.action(request.payload)
    send({ id: request.id, ok: true, value })
  } catch (error) {
    send({ id: request.id, ok: false, error: serializeError(error) })
  }
}

function getAdapter(): ReturnType<typeof WindowsTerminatorAdapter.create> {
  if (!adapterPromise) adapterPromise = WindowsTerminatorAdapter.create()
  return adapterPromise
}

function send(response: DesktopProcessResponse): void {
  parentPort.postMessage(toSerializable(response))
}

function toSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  ))) as T
}

function serializeError(value: unknown): SerializedDesktopError {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return { name: 'Error', message: String(value) }
}
