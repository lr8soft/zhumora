import assert from 'node:assert/strict'

import { buildSystemPrompt } from '../src/main/agent/promptBuilder.ts'

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

console.log('system prompt visual-output guidance tests passed')
