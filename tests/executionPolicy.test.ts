import assert from 'node:assert/strict'
import { ManifestCapabilityPolicy } from '../src/main/execution/capabilityPolicy.ts'
import { ToolExecutionService } from '../src/main/execution/service.ts'
import { ToolExecutionRouter } from '../src/main/execution/router.ts'
import type { ToolHandlerExecutor } from '../src/main/execution/contracts.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'

function handler(name: string, onExecute: () => void) {
  return {
    definition: {
      type: 'function' as const,
      function: { name, description: name, parameters: { type: 'object' } }
    },
    async execute() {
      onExecute()
      return { content: `${name}-handler` }
    }
  }
}

const routedRegistry = new ToolRegistry()
routedRegistry.register('local_tool', handler('local_tool', () => {}), 'builtin', {
  capabilities: ['filesystem.read'],
  executionClass: 'in-process'
})
routedRegistry.register('remote_tool', handler('remote_tool', () => {}), 'mcp:server-a', {
  capabilities: ['mcp.call'],
  executionClass: 'mcp'
})

const routed: string[] = []
const executor = (label: string): ToolHandlerExecutor => ({
  async execute(entry) {
    routed.push(`${label}:${entry.manifest.name}`)
    return { content: label }
  }
})
const router = new ToolExecutionRouter({
  'in-process': executor('local-executor'),
  mcp: executor('mcp-executor')
})
const routedService = new ToolExecutionService({ registry: routedRegistry, router })

const local = await routedService.execute({
  toolCall: { id: 'local-1', type: 'function', function: { name: 'local_tool', arguments: '{}' } },
  context: { workspacePath: process.cwd() }
})
const remote = await routedService.execute({
  toolCall: { id: 'remote-1', type: 'function', function: { name: 'remote_tool', arguments: '{}' } },
  context: { workspacePath: process.cwd() }
})
assert.equal(local.output.content, 'local-executor')
assert.equal(remote.output.content, 'mcp-executor')
assert.deepEqual(routed, ['local-executor:local_tool', 'mcp-executor:remote_tool'])

let deniedExecutions = 0
let deniedPermissionChecks = 0
const deniedRegistry = new ToolRegistry()
deniedRegistry.register('host_command', handler('host_command', () => { deniedExecutions++ }), 'builtin', {
  capabilities: ['process.spawn'],
  executionClass: 'host-process'
})
const deniedService = new ToolExecutionService({
  registry: deniedRegistry,
  policy: new ManifestCapabilityPolicy({
    allowedCapabilities: ['filesystem.read'],
    allowLegacyUnclassified: false
  })
})
const denied = await deniedService.execute({
  toolCall: { id: 'host-1', type: 'function', function: { name: 'host_command', arguments: '{}' } },
  context: { workspacePath: process.cwd() },
  permissionCheck: async () => { deniedPermissionChecks++; return true }
})
assert.equal(denied.disposition, 'policy-denied')
assert.match(denied.output.content, /process\.spawn.*not allowed/)
assert.equal(deniedPermissionChecks, 0, 'policy denial happens before permission presentation')
assert.equal(deniedExecutions, 0)

let failedPolicyPermissionChecks = 0
const failedPolicyService = new ToolExecutionService({
  registry: deniedRegistry,
  policy: { evaluate() { throw new Error('policy backend unavailable') } }
})
const failedPolicy = await failedPolicyService.execute({
  toolCall: { id: 'host-2', type: 'function', function: { name: 'host_command', arguments: '{}' } },
  context: { workspacePath: process.cwd() },
  permissionCheck: async () => { failedPolicyPermissionChecks++; return true }
})
assert.equal(failedPolicy.disposition, 'policy-denied')
assert.match(failedPolicy.output.content, /policy evaluation failed/)
assert.equal(failedPolicyPermissionChecks, 0, 'a broken policy fails closed before permission')
assert.equal(deniedExecutions, 0)

const policyAbortController = new AbortController()
const abortedByPolicyService = new ToolExecutionService({
  registry: deniedRegistry,
  policy: {
    async evaluate() {
      policyAbortController.abort()
      return { allowed: true }
    }
  }
})
const abortedByPolicy = await abortedByPolicyService.execute({
  toolCall: { id: 'host-3', type: 'function', function: { name: 'host_command', arguments: '{}' } },
  context: { workspacePath: process.cwd(), signal: policyAbortController.signal }
})
assert.equal(abortedByPolicy.disposition, 'aborted')
assert.equal(deniedExecutions, 0, 'an asynchronous policy cannot resume an aborted run')

let sandboxExecutions = 0
let sandboxPermissionChecks = 0
const sandboxRegistry = new ToolRegistry()
sandboxRegistry.register('sandboxed_command', handler('sandboxed_command', () => { sandboxExecutions++ }), 'builtin', {
  capabilities: ['process.spawn'],
  executionClass: 'sandbox'
})
const sandboxService = new ToolExecutionService({ registry: sandboxRegistry })
const unavailable = await sandboxService.execute({
  toolCall: { id: 'sandbox-1', type: 'function', function: { name: 'sandboxed_command', arguments: '{}' } },
  context: { workspacePath: process.cwd() },
  permissionCheck: async () => { sandboxPermissionChecks++; return true }
})
assert.equal(unavailable.disposition, 'executor-unavailable')
assert.equal(sandboxPermissionChecks, 0, 'an unavailable route does not request permission')
assert.equal(sandboxExecutions, 0, 'sandbox class never falls back to host execution')

const inconsistent = await new ManifestCapabilityPolicy().evaluate({
  manifest: {
    ...routedRegistry.get('local_tool')!.manifest,
    capabilities: ['mcp.call'],
    executionClass: 'in-process'
  },
  args: {},
  context: { workspacePath: process.cwd() }
})
assert.equal(inconsistent.allowed, false)
assert.match(inconsistent.reason || '', /MCP execution class/)

console.log('capability policy and execution router tests passed')
