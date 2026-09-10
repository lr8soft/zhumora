import assert from 'node:assert/strict'
import {
  getCompactThreshold,
  measureContextBudget,
  needsCompact
} from '../src/main/agent/contextBudget.ts'
import type { ChatMessage, ToolDefinition } from '../src/shared/types.ts'

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are an agent.' },
  { role: 'user', content: 'X'.repeat(20_000) }
]
const tools: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'edit',
    description: 'Edit a file',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', description: 'Y'.repeat(30_000) } }
    }
  }
}]

const withoutTools = measureContextBudget(messages, 16_000)
const withTools = measureContextBudget(messages, 16_000, tools)
assert(withTools.toolDefinitionTokens > 0, '工具 schema 被计入预算')
assert(withTools.estimatedRequestTokens > withoutTools.estimatedRequestTokens, '完整请求估算包含工具开销')
assert.equal(getCompactThreshold(16_000), 12_960, '压缩阈值保持 context window 的 81%')
assert.equal(needsCompact(messages, 16_000), false, '仅消息尚未触发压缩')
assert.equal(needsCompact(messages, 16_000, tools), true, '计入大工具 schema 后触发压缩')

// 本次故障的量级：旧估算约 192.5k、窗口 262k。即便暂不计算工具
// schema，安全系数也应在危险边缘前触发，而不是把请求送到 llama.cpp。
const longHistory: ChatMessage[] = [{ role: 'user', content: 'Z'.repeat(192_500 * 4) }]
assert.equal(needsCompact(longHistory, 262_000), true, '危险边缘的长上下文会提前压缩')

console.log('context budget tests passed')
