import { toolChainRevision, toolPresentationRevision } from '../src/shared/toolPresentation.ts'
import type { ToolCall } from '../src/shared/types.ts'

const calls: ToolCall[] = [
  { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } },
  { id: 'call-2', type: 'function', function: { name: 'bash', arguments: '{}' } }
]

const pending = toolPresentationRevision(calls, {})
const firstDone = toolPresentationRevision(calls, { 'call-1': 'result-1:done' })
const secondDone = toolPresentationRevision(calls, {
  'call-1': 'result-1:done',
  'call-2': 'result-2:done'
})
const firstErrored = toolPresentationRevision(calls, {
  'call-1': 'result-1:error',
  'call-2': 'result-2:done'
})

if (pending === firstDone) throw new Error('first completed tool must change its presentation revision')
if (firstDone === secondDone) throw new Error('second completed tool must change its presentation revision')
if (secondDone === firstErrored) throw new Error('status changes must change its presentation revision')
if (toolPresentationRevision(undefined, {}) !== '') throw new Error('messages without tool calls need no revision')

// ---------- 工具链修订标记 ----------

{
  const m1 = { id: 'a1', toolCalls: calls }
  const base = toolChainRevision([m1], {})
  const done1 = toolChainRevision([m1], { 'call-1': 't1:done' })
  const done2 = toolChainRevision([m1], { 'call-1': 't1:done', 'call-2': 't2:done' })
  if (base === done1) throw new Error('chain: landing a result must change the revision')
  if (done1 === done2) throw new Error('chain: second result must change the revision')

  const appended = toolChainRevision([m1, { id: 'a2', toolCalls: calls }], { 'call-1': 't1:done' })
  if (appended === done1) throw new Error('chain: appending a member must change the revision')
  // 成员序列相同但结果不同 → 不同
  const errored = toolChainRevision([m1], { 'call-1': 't1:error' })
  if (done1 === errored) throw new Error('chain: status flip must change the revision')
  // 完全相同的输入 → 相同（memo 跳过的前提）
  if (toolChainRevision([m1], { 'call-1': 't1:done' }) !== done1) {
    throw new Error('chain: identical inputs must produce identical revisions')
  }
}

console.log('\ntool presentation\n  ✓ tool results update memoized bubbles immediately\n  ✓ chain revision tracks members and node states\n\n1 passed, 0 failed')
