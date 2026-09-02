import { toolPresentationRevision } from '../src/shared/toolPresentation.ts'
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
if (secondDone === firstErrored) throw new Error('status changes must change the presentation revision')
if (toolPresentationRevision(undefined, {}) !== '') throw new Error('messages without tool calls need no revision')

console.log('\ntool presentation\n  ✓ tool results update memoized bubbles immediately\n\n1 passed, 0 failed')
