import assert from 'node:assert/strict'
import { SandboxToolExecutor, type SandboxRuntimeRequest } from '../src/main/execution/sandboxExecutor.ts'
import { ToolExecutionService } from '../src/main/execution/service.ts'
import { ToolExecutionRouter } from '../src/main/execution/router.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'

assert.throws(
  () => new SandboxToolExecutor({
    profile: { id: 'advisory-only', isolation: 'advisory' },
    async execute() { return { content: 'nope' } }
  } as never),
  /os-enforced isolation/
)

let hostHandlerExecutions = 0
let runtimeRequest: SandboxRuntimeRequest | undefined
const registry = new ToolRegistry()
registry.register('isolated_read', {
  definition: {
    type: 'function',
    function: {
      name: 'isolated_read',
      description: 'isolated',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  },
  async execute() {
    hostHandlerExecutions++
    return { content: 'host handler must stay unreachable' }
  }
}, 'builtin', {
  capabilities: ['filesystem.read'],
  executionClass: 'sandbox',
  version: '2'
})

const sandboxExecutor = new SandboxToolExecutor({
  profile: { id: 'test-os-sandbox', isolation: 'os-enforced' },
  async execute(request) {
    runtimeRequest = request
    request.args.path = 'mutated-in-runtime'
    return { content: 'sandbox-result' }
  }
})
const service = new ToolExecutionService({
  registry,
  router: new ToolExecutionRouter({ sandbox: sandboxExecutor })
})
const outcome = await service.execute({
  toolCall: {
    id: 'sandbox-call-1',
    type: 'function',
    function: { name: 'isolated_read', arguments: '{"path":"inside.txt"}' }
  },
  context: { workspacePath: 'C:\\workspace', sessionId: 'session-1' }
})

assert.equal(outcome.disposition, 'completed')
assert.equal(outcome.output.content, 'sandbox-result')
assert.equal(hostHandlerExecutions, 0, 'sandbox runtime never receives or invokes the host handler')
assert.deepEqual(runtimeRequest, {
  toolId: 'builtin/isolated_read',
  toolName: 'isolated_read',
  toolVersion: '2',
  capabilities: ['filesystem.read'],
  args: { path: 'mutated-in-runtime' },
  workspacePath: 'C:\\workspace',
  sessionId: 'session-1'
})
assert.deepEqual(outcome.args, { path: 'inside.txt' }, 'runtime receives a cloned argument object')

console.log('sandbox executor boundary tests passed')
