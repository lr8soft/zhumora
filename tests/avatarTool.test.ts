import assert from 'node:assert/strict'
import type { AvatarCommand } from '../src/shared/avatar.ts'
import type { ToolExecutionResult } from '../src/shared/types.ts'
import type { AvatarController } from '../src/main/avatar/contracts.ts'
import { createAvatarTools } from '../src/main/tools/avatar.ts'
import { ToolRegistry } from '../src/main/tools/registry.ts'

const calls: Array<{ sessionId?: string; command: AvatarCommand; signal?: AbortSignal }> = []
const controller: AvatarController = {
  buildSystemPrompt: () => '',
  async execute(sessionId, command, signal): Promise<ToolExecutionResult> {
    calls.push({ sessionId, command, signal })
    return { content: 'acknowledged' }
  }
}

const registry = new ToolRegistry()
registry.register('unrelated_tool', {
  definition: {
    type: 'function',
    function: { name: 'unrelated_tool', description: 'unrelated', parameters: { type: 'object' } }
  },
  async execute() { return { content: 'unrelated' } }
})
for (const tool of createAvatarTools(controller)) registry.register(tool.name, tool.handler)

assert.ok(registry.get('unrelated_tool'))
const avatar = registry.get('avatar_control')!.handler
assert.equal(registry.permission('avatar_control'), 'normal')
const abortController = new AbortController()
const result = await avatar.execute(
  { action: 'play_animation', animation: 'Wave', loop: true },
  { workspacePath: process.cwd(), sessionId: 'session-1', signal: abortController.signal }
)
assert.deepEqual(result, { content: 'acknowledged' })
assert.deepEqual(calls[0], {
  sessionId: 'session-1',
  command: { type: 'play_animation', animation: 'Wave', loop: true },
  signal: abortController.signal
})

assert.deepEqual(
  await avatar.execute({ action: 'play_animation' }, { workspacePath: process.cwd(), sessionId: 'session-1' }),
  { content: 'play_animation requires "animation".', isError: true }
)
assert.equal(calls.length, 1)

console.log('avatar tool tests passed')
