import assert from 'node:assert/strict'
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

console.log('tool executor tests passed')
