import assert from 'node:assert/strict'
import { executeToolCall } from '../src/main/agent/toolExecutor.ts'
import { ToolExecutionService } from '../src/main/execution/service.ts'
import { normalizeToolOutput, ToolRegistry } from '../src/main/tools/registry.ts'

const registry = new ToolRegistry()
registry.register('capture', {
  definition: {
    type: 'function',
    function: { name: 'capture', description: 'capture', parameters: { type: 'object' } }
  },
  async execute() {
    return {
      content: 'captured',
      attachments: [{ type: 'image', mediaType: 'image/png', base64: 'aGVsbG8=', detail: 'low' }]
    }
  }
})

const output = normalizeToolOutput(await registry.get('capture')!.handler.execute({}, { workspacePath: process.cwd() }))
assert.equal(output.content, 'captured')
assert.deepEqual(output.attachments, [
  { type: 'image', mediaType: 'image/png', base64: 'aGVsbG8=', detail: 'low' }
])
assert.deepEqual(normalizeToolOutput('legacy text'), { content: 'legacy text' })
assert.doesNotMatch(JSON.stringify(output), /__IMAGE_BASE64__/)

const service = new ToolExecutionService({ registry })
const wrapped = await executeToolCall({
  toolCall: { id: 'call-1', type: 'function', function: { name: 'capture', arguments: '{}' } },
  service,
  context: { workspacePath: process.cwd() }
})
assert.equal(wrapped.isError, false)
assert.equal(wrapped.displayContent, 'captured\n[image attached, sent to LLM for visual analysis]')
assert.ok(Array.isArray(wrapped.llmMessage.content))

let strictExecutions = 0
registry.register('strict', {
  definition: {
    type: 'function',
    function: {
      name: 'strict',
      description: 'strict',
      parameters: {
        type: 'object',
        properties: { value: { type: 'integer', minimum: 1 } },
        required: ['value'],
        additionalProperties: false
      }
    }
  },
  async execute() {
    strictExecutions++
    return { content: 'strict-ok' }
  }
})

let permissionChecks = 0
const invalid = await service.execute({
  toolCall: { id: 'call-2', type: 'function', function: { name: 'strict', arguments: '{"value":0,"extra":true}' } },
  context: { workspacePath: process.cwd() },
  permissionCheck: async () => { permissionChecks++; return true }
})
assert.equal(invalid.disposition, 'invalid-arguments')
assert.match(invalid.output.content, /\$\.value: value must be at least 1/)
assert.match(invalid.output.content, /\$\.extra: additional property is not allowed/)
assert.equal(permissionChecks, 0, 'invalid arguments fail before permission presentation')
assert.equal(strictExecutions, 0)

const denied = await service.execute({
  toolCall: { id: 'call-3', type: 'function', function: { name: 'strict', arguments: '{"value":1}' } },
  context: { workspacePath: process.cwd() },
  permissionCheck: async () => false
})
assert.equal(denied.disposition, 'permission-denied')
assert.equal(strictExecutions, 0)

const abortController = new AbortController()
const aborted = await service.execute({
  toolCall: { id: 'call-4', type: 'function', function: { name: 'strict', arguments: '{"value":1}' } },
  context: { workspacePath: process.cwd(), signal: abortController.signal },
  permissionCheck: async () => { abortController.abort(); return true }
})
assert.equal(aborted.disposition, 'aborted')
assert.equal(strictExecutions, 0, 'a late approval cannot execute after abort')

registry.register('throws', {
  definition: { type: 'function', function: { name: 'throws', description: '', parameters: { type: 'object' } } },
  async execute() { throw new Error('boom') }
})
const failed = await service.execute({
  toolCall: { id: 'call-5', type: 'function', function: { name: 'throws', arguments: '{}' } },
  context: { workspacePath: process.cwd() }
})
assert.equal(failed.disposition, 'failed')
assert.equal(failed.output.content, 'Error: boom')

console.log('tool executor tests passed')
