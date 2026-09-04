import assert from 'node:assert/strict'
import { PermissionBroker } from '../src/main/agent/permissionBroker.ts'
import { decidePermission } from '../src/main/agent/permissionPolicy.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'

assert.equal(decidePermission('manual', 'safe', false), 'allow')
assert.equal(decidePermission('manual', 'normal', false), 'confirm')
assert.equal(decidePermission('auto', 'normal', false), 'allow')
assert.equal(decidePermission('auto', 'dangerous', false), 'confirm')
assert.equal(decidePermission('full', 'dangerous', false), 'allow')
assert.equal(decidePermission('full', 'safe', true), 'confirm')

const registry = new ToolRegistry()
const handler = (permission: 'safe' | 'normal' | 'dangerous', alwaysConfirm = false) => ({
  definition: {
    type: 'function' as const,
    function: { name: permission, description: permission, parameters: { type: 'object' } }
  },
  permission,
  alwaysConfirm,
  execute: async () => ({ content: 'ok' })
})
registry.register('safe', handler('safe'))
registry.register('normal', handler('normal'))
registry.register('dangerous', handler('dangerous'))
registry.register('boundary', handler('safe', true))

const broker = new PermissionBroker()
const presented: string[] = []
const resolved: string[] = []
broker.addPresenter({
  present: request => presented.push(request.id),
  resolve: (_request, resolution) => resolved.push(resolution)
})
const manual = broker.createCheck({ sessionId: 's1', mode: () => 'manual', registry })
assert.equal(await manual('safe', {}), true)

const presenterlessBroker = new PermissionBroker()
const presenterless = presenterlessBroker.createCheck({ sessionId: 'none', mode: () => 'manual', registry })
assert.equal(await presenterless('normal', {}), false)

const pending = manual('normal', {})
assert.equal(presented.length, 1)
assert.equal(broker.respond(presented[0], true), true)
assert.equal(await pending, true)
assert.deepEqual(resolved, ['approved'])
assert.equal(broker.respond(presented[0], false), false, 'first response wins')

const resilientBroker = new PermissionBroker()
let resilientId = ''
resilientBroker.addPresenter({ present: () => { throw new Error('closed window') } })
resilientBroker.addPresenter({ present: request => { resilientId = request.id } })
const resilientPending = resilientBroker.request({ sessionId: 'resilient', toolName: 'normal', args: {}, level: 'normal' })
await Promise.resolve()
assert.ok(resilientId)
assert.equal(resilientBroker.respond(resilientId, true), true)
assert.equal(await resilientPending, true)

const full = broker.createCheck({ sessionId: 's2', mode: () => 'full', registry })
assert.equal(await full('dangerous', {}), true)
const boundary = full('boundary', {})
const boundaryId = presented.at(-1)!
broker.cancelSession('s2')
assert.equal(await boundary, false)
assert.equal(resolved.at(-1), 'cancelled')

const timed = broker.request({ sessionId: 's3', toolName: 'normal', args: {}, level: 'normal' }, [], 5)
assert.equal(await timed, false)
assert.equal(resolved.at(-1), 'timeout')
broker.dispose()

console.log('permission policy and broker tests passed')
