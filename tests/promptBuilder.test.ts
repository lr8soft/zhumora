import assert from 'node:assert/strict'

import { buildSystemPrompt } from '../src/main/agent/promptBuilder.ts'
import { subagentDelegationGuidance, SUBAGENT_CHILD_GUIDANCE } from '../src/main/agent/subagentPolicy.ts'

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
  subagentDelegationGuidance(true, null, [{ id: 'p', name: 'provider', baseUrl: 'https://test', apiKey: 'private-key', defaultModel: 'm', enabled: true, maxConcurrency: 3 }]))
for (const guidance of [/architect and project manager/, /exactly one project file/, /targetFile/, /provider.*configured maxConcurrency/,
  /Review actual diffs/, /integration tests\/build/, /settled terminal state/, /ownership contract/]) assert.match(coordinated, guidance)
assert.match(coordinated, /"maxConcurrency":3/)
assert.match(coordinated, /null means unlimited/)
assert.doesNotMatch(coordinated, /\d+ (simultaneous child runs|child turns per parent run)/)
assert.doesNotMatch(coordinated, /private-key/)
assert.match(SUBAGENT_CHILD_GUIDANCE, /do not change adjacent files/)
assert.match(SUBAGENT_CHILD_GUIDANCE, /focused validation/)
assert.doesNotMatch(subagentDelegationGuidance(false, null), /Launch as many/)

console.log('system prompt visual-output guidance tests passed')
