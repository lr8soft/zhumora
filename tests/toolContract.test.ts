import assert from 'node:assert/strict'
import { createMcpToolName, isValidModelToolName } from '../src/main/tools/manifest.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'
import { validateToolArguments } from '../src/main/tools/schemaValidator.ts'

const handler = (name: string) => ({
  definition: {
    type: 'function' as const,
    function: {
      name,
      description: name,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write'] },
          target: { type: 'string', minLength: 1 },
          flags: { type: 'array', items: { type: 'string' }, uniqueItems: true }
        },
        required: ['action', 'target'],
        additionalProperties: false
      }
    }
  },
  async execute() { return { content: 'ok' } }
})

const registry = new ToolRegistry()
registry.register('files', handler('files'), 'builtin', {
  capabilities: ['filesystem.read'],
  idempotency: 'idempotent'
})
const registered = registry.get('files')!
assert.equal(registered.manifest.id, 'builtin/files')
assert.equal(registered.manifest.originalName, 'files')
assert.deepEqual(registered.manifest.capabilities, ['filesystem.read'])
assert.equal(registered.manifest.idempotency, 'idempotent')
assert.deepEqual(registered.manifest.inputSchema, registered.handler.definition.function.parameters)
assert.notEqual(registered.manifest.inputSchema, registered.handler.definition.function.parameters)
assert.equal(Object.isFrozen(registered.manifest.inputSchema), true)

assert.throws(() => registry.register('files', handler('files'), 'mcp:other'), /collision/)
assert.throws(() => registry.register('mismatch', handler('different')), /does not match/)
assert.throws(() => registry.register('invalid.name', handler('invalid.name')), /Invalid model-facing tool name/)

const first = createMcpToolName('server-a', 'search/files')
const same = createMcpToolName('server-a', 'search/files')
const otherServer = createMcpToolName('server-b', 'search/files')
const lossyPeer = createMcpToolName('server-a', 'search.files')
assert.equal(first, same)
assert.notEqual(first, otherServer)
assert.notEqual(first, lossyPeer)
assert.equal(isValidModelToolName(first), true)
assert.ok(first.length <= 64)
assert.equal(createMcpToolName('x'.repeat(100), 'y'.repeat(100)).length, 64)

const valid = validateToolArguments(registered.manifest.inputSchema, {
  action: 'read', target: 'src', flags: ['recursive']
})
assert.deepEqual(valid, { valid: true, issues: [] })

const invalid = validateToolArguments(registered.manifest.inputSchema, {
  action: 'delete', flags: ['same', 'same'], unexpected: true
})
assert.equal(invalid.valid, false)
assert.deepEqual(invalid.issues.map(issue => [issue.path, issue.keyword]), [
  ['$.target', 'required'],
  ['$.action', 'enum'],
  ['$.flags', 'uniqueItems'],
  ['$.unexpected', 'additionalProperties']
])

const union = validateToolArguments({
  oneOf: [
    { type: 'string', const: 'auto' },
    { type: 'integer', minimum: 1, maximum: 5 }
  ]
}, 3)
assert.equal(union.valid, true)

console.log('tool manifest, namespace and schema validation tests passed')
