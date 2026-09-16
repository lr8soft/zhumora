import assert from 'node:assert/strict'

import type { ToolCall, UIMessage } from '../src/shared/types.ts'
import { buildTimelineRows } from '../src/renderer/src/timeline.ts'

const toolCall: ToolCall = {
  id: 'call-1',
  type: 'function',
  function: { name: 'read_file', arguments: '{"path":"a"}' }
}

const message = (overrides: Partial<UIMessage>): UIMessage => ({
  id: overrides.id || crypto.randomUUID(),
  sessionId: 's1',
  role: 'user',
  content: '',
  timestamp: 1,
  ...overrides
})

{
  const rows = buildTimelineRows([], { sessionId: 's1', isRunning: false })
  assert.deepEqual(rows, [])
}

{
  const assistant = message({ id: 'a1', role: 'assistant', content: 'working', toolCalls: [toolCall] })
  const result = message({
    id: 't1',
    role: 'tool',
    content: 'file contents',
    toolCallId: toolCall.id,
    toolName: 'read_file',
    status: 'done'
  })
  const rows = buildTimelineRows([assistant, result], { sessionId: 's1', isRunning: false })
  assert.equal(rows.length, 1, 'referenced tool result is merged into its assistant row')
  const row = rows[0]
  assert.equal(row.type, 'message')
  if (row.type !== 'message') throw new Error('expected message row')
  assert.equal(row.message, assistant)
  assert.equal(row.toolStatuses?.[toolCall.id], 'done')
  assert.deepEqual(row.toolResults?.[toolCall.id], { content: 'file contents', isError: false })
  assert.equal(row.toolRevision, 't1:done')
}

{
  const orphan = message({ id: 'orphan', role: 'tool', content: 'orphan', toolCallId: 'missing' })
  const rows = buildTimelineRows([orphan], { sessionId: 's1', isRunning: false })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, 'message:orphan', 'orphan tool results remain visible')
}

{
  const before = message({ id: 'before', content: 'before' })
  const after = message({ id: 'after', content: 'after' })
  const rows = buildTimelineRows([before, after], {
    sessionId: 's1',
    isRunning: false,
    compaction: { upToMessageId: 'before' }
  })
  assert.deepEqual(rows.map(row => row.key), ['message:before', 'compaction:before', 'message:after'])
}

{
  const done = message({ id: 'done', role: 'assistant', status: 'done' })
  const retryStatus = { failedAttempt: 2, maxRetries: 5 }
  const rows = buildTimelineRows([done], { sessionId: 's1', isRunning: true, retryStatus })
  assert.equal(rows.at(-1)?.key, 'retry:s1')

  const thinking = message({ id: 'thinking', role: 'assistant', status: 'thinking' })
  const thinkingRows = buildTimelineRows([thinking], { sessionId: 's1', isRunning: true, retryStatus })
  assert.equal(thinkingRows.length, 1, 'thinking bubble owns the retry presentation')
  assert.equal(thinkingRows[0].type === 'message' ? thinkingRows[0].retryStatus : undefined, retryStatus)
}

console.log('renderer timeline projection tests passed')
