import assert from 'node:assert/strict'

import { buildSystemPrompt } from '../src/main/agent/promptBuilder.ts'
import { subagentDelegationGuidance, SUBAGENT_CHILD_GUIDANCE } from '../src/main/agent/subagentPolicy.ts'
import { createSubagentFixture } from './helpers/subagentFixture.ts'

const prompt = buildSystemPrompt('D:\\workspace', '', '', {
  tools: [],
  builtinTools: [],
  mcpTools: [],
  mcpServers: []
})

assert.match(prompt, /## Visual Output/)
assert.match(prompt, /language identifier is exactly mermaid/)
assert.match(prompt, /presentation capability, not a tool/)
assert.match(prompt, /Do not use HTML labels, click directives, hyperlinks/)
assert.match(prompt, /external chat channel/)
const coordinated = buildSystemPrompt('D:\\workspace', '', '', { tools: [], builtinTools: [], mcpTools: [], mcpServers: [] },
  subagentDelegationGuidance(true, [], 'priority', [{ id: 'p', name: 'provider', baseUrl: 'https://test', apiKey: 'private-key', defaultModel: 'm', enabled: true, maxConcurrency: 3 }]))
for (const guidance of [/architect and project manager/, /exactly one project file/, /targetFile/, /provider.*configured maxConcurrency/,
  /Review actual diffs/, /integration tests\/build/, /settled terminal state/, /ownership contract/]) assert.match(coordinated, guidance)
assert.match(coordinated, /"maxConcurrency":3/)
assert.match(coordinated, /null means unlimited/)
assert.doesNotMatch(coordinated, /\d+ (simultaneous child runs|child turns per parent run)/)
assert.doesNotMatch(coordinated, /private-key/)
assert.match(SUBAGENT_CHILD_GUIDANCE, /do not change adjacent files/)
assert.match(SUBAGENT_CHILD_GUIDANCE, /focused validation/)
assert.match(coordinated, /explorer answers one read-only question/)
assert.match(coordinated, /dependsOn/)
assert.match(coordinated, /send_subagent_message/)
assert.match(coordinated, /completed child is not automatically an accepted change/)
assert.doesNotMatch(buildSystemPrompt('D:/workspace', '', '', { tools: [], builtinTools: [], mcpTools: [], mcpServers: [] }, undefined, undefined, false), /## Long-term Memory/)
assert.doesNotMatch(subagentDelegationGuidance(false, [], 'priority'), /Launch as many/)
assert.match(coordinated, /application distributes new tasks/)
assert.match(coordinated, /priority sequence/)
assert.match(coordinated, /SAME settled child session/)
assert.match(coordinated, /recovery.continuation_ready/)
assert.match(coordinated, /repeated_failure_kind/)

console.log('system prompt visual-output guidance tests passed')

// Exercise production SessionService assembly, not just standalone prompt constants.
{
  const f = createSubagentFixture()
  try {
    const root = await f.root()
    const render = (options: typeof root.options) => buildSystemPrompt('D:/workspace', '', '', options.promptRuntime!,
      options.systemPromptExtra, options.systemPromptRole)
    const parentPrompt = render(root.options)
    assert.ok(parentPrompt.indexOf('lead architect and coordinator') < parentPrompt.indexOf('## Environment'))
    assert.match(parentPrompt, /without waiting for the user to mention subagents/)
    assert.match(parentPrompt, /Before implementing a nontrivial task/)
    assert.match(parentPrompt, /Ordinary tool calls execute sequentially/)
    assert.match(parentPrompt, /\*\*Agent Collaboration:\*\*/)
    assert.doesNotMatch(parentPrompt, /Good parallelism:|edit multiple files in one response/)
    assert.match(parentPrompt, /Example: after agreeing a shared interface/)
    const child = await root.scope.spawn({ description: 'single file', prompt: 'inspect it' })
    const childPrompt = render(f.running.get(child.session_id)!.options)
    assert.match(childPrompt, /You are a focused subagent/)
    assert.doesNotMatch(childPrompt, /lead architect and coordinator|Proactive delegation is the default/)
    f.setDelegation(false)
    const disabled = await f.root('disabled')
    assert.doesNotMatch(render(disabled.options), /lead architect and coordinator|Proactive delegation is the default/)
    assert.match(render(disabled.options), /Subagents are disabled/)
    assert.deepEqual(disabled.options.promptRuntime!.tools, root.options.promptRuntime!.tools)
  } finally { await f.service.stopAll(); f.permissions.dispose() }
}
