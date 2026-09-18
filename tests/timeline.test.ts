import assert from 'node:assert/strict'

import type { ToolCall, UIMessage } from '../src/shared/types.ts'
import { buildTimelineRows, buildToolChainNodes } from '../src/renderer/src/timeline.ts'
import type { ToolChainTimelineRow } from '../src/renderer/src/timeline.ts'

const toolCall = (id: string, name = 'read_file'): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: `{"path":"${id}"}` }
})

const message = (overrides: Partial<UIMessage>): UIMessage => ({
  id: overrides.id || crypto.randomUUID(),
  sessionId: 's1',
  role: 'user',
  content: '',
  timestamp: 1,
  ...overrides
})

const options = { sessionId: 's1', isRunning: false }

const toolResult = (id: string, callId: string, name: string, content = 'ok', status: UIMessage['status'] = 'done'): UIMessage =>
  message({ id, role: 'tool', content, toolCallId: callId, toolName: name, status })

{
  const rows = buildTimelineRows([], { sessionId: 's1', isRunning: false })
  assert.deepEqual(rows, [])
}

{
  const assistant = message({ id: 'a1', role: 'assistant', content: 'working', toolCalls: [toolCall('call-1')] })
  const result = toolResult('t1', 'call-1', 'read_file', 'file contents')
  const rows = buildTimelineRows([assistant, result], options)
  assert.equal(rows.length, 1, 'referenced tool result is merged into its assistant row')
  const row = rows[0]
  assert.equal(row.type, 'message')
  if (row.type !== 'message') throw new Error('expected message row')
  assert.equal(row.message, assistant)
  assert.equal(row.toolStatuses?.['call-1'], 'done')
  assert.deepEqual(row.toolResults?.['call-1'], { content: 'file contents', isError: false })
  assert.equal(row.toolRevision, 't1:done')
}

{
  const orphan = message({ id: 'orphan', role: 'tool', content: 'orphan', toolCallId: 'missing' })
  const rows = buildTimelineRows([orphan], options)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, 'message:orphan', 'orphan tool results remain visible')
}

{
  const before = message({ id: 'before', content: 'before' })
  const after = message({ id: 'after', content: 'after' })
  const rows = buildTimelineRows([before, after], {
    ...options,
    compaction: { upToMessageId: 'before' }
  })
  assert.deepEqual(rows.map(row => row.key), ['message:before', 'compaction:before', 'message:after'])
}

{
  const done = message({ id: 'done', role: 'assistant', status: 'done' })
  const retryStatus = { failedAttempt: 2, maxRetries: 5 }
  const rows = buildTimelineRows([done], { ...options, isRunning: true, retryStatus })
  assert.equal(rows.at(-1)?.key, 'retry:s1')

  const thinking = message({ id: 'thinking', role: 'assistant', status: 'thinking' })
  const thinkingRows = buildTimelineRows([thinking], { ...options, isRunning: true, retryStatus })
  assert.equal(thinkingRows.length, 1, 'thinking bubble owns the retry presentation')
  assert.equal(thinkingRows[0].type === 'message' ? thinkingRows[0].retryStatus : undefined, retryStatus)
}

// ---------- 工具链聚合（连续纯工具轮 → 一条链行）----------

{
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1')], status: 'pending' })
  const a2 = message({ id: 'a2', role: 'assistant', toolCalls: [toolCall('c2')], status: 'pending' })
  const a3 = message({ id: 'a3', role: 'assistant', toolCalls: [toolCall('c3')], status: 'pending' })
  const rows = buildTimelineRows([a1, a2, a3], options)
  assert.equal(rows.length, 1, 'consecutive pure tool rounds collapse into one chain row')
  const row = rows[0]
  assert.equal(row.type, 'chain')
  if (row.type !== 'chain') throw new Error('expected chain row')
  assert.equal(row.key, 'chain:a1', 'chain key anchors at the first member')
  assert.deepEqual(row.nodes.map(node => node.toolCallId), ['c1', 'c2', 'c3'])
  assert.ok(row.nodes.every(node => node.status === 'running'), 'unresolved calls render as running nodes')
}

{
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1', 'read_file')], status: 'pending' })
  const a2 = message({ id: 'a2', role: 'assistant', toolCalls: [toolCall('c2', 'bash')], status: 'pending' })
  const t1 = toolResult('t1', 'c1', 'read_file')
  const t2 = toolResult('t2', 'c2', 'bash')
  // 历史里 tool 结果消息穿插在 assistant 组之间 → 不拆链
  const rows = buildTimelineRows([a1, t1, a2, t2], options)
  assert.equal(rows.length, 1, 'interleaved tool result messages do not split the chain')
  const row = rows[0]
  if (row.type !== 'chain') throw new Error('expected chain row')
  assert.deepEqual(row.nodes.map(node => [node.toolCallId, node.status]), [
    ['c1', 'done'],
    ['c2', 'done']
  ])
  assert.equal(row.nodes[0].content, 'ok')
}

{
  const before = message({ id: 'before', content: 'before' })
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1')], status: 'pending' })
  const a2 = message({ id: 'a2', role: 'assistant', toolCalls: [toolCall('c2')], status: 'pending' })
  const rows = buildTimelineRows([before, a1, a2], options)
  assert.deepEqual(rows.map(row => row.key), ['message:before', 'chain:a1'], 'user message precedes the chain row')
  assert.equal(rows[1].type, 'chain')
}

{
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1')], status: 'pending' })
  const text = message({ id: 'text', role: 'assistant', content: 'partial answer' })
  const a2 = message({ id: 'a2', role: 'assistant', toolCalls: [toolCall('c2')], status: 'pending' })
  const rows = buildTimelineRows([a1, text, a2], options)
  assert.deepEqual(rows.map(row => row.key), ['chain:a1', 'message:text', 'chain:a2'],
    'a text turn breaks the chain and starts a new one')
}

{
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1')], status: 'pending' })
  const thinking = message({ id: 'think', role: 'assistant', reasoning: 'let me think', status: 'thinking' })
  const a2 = message({ id: 'a2', role: 'assistant', toolCalls: [toolCall('c2')], status: 'pending' })
  const rows = buildTimelineRows([a1, thinking, a2], options)
  assert.deepEqual(rows.map(row => row.key), ['chain:a1', 'message:think', 'chain:a2'],
    'a reasoning-only turn breaks the chain (reasoning rounds never enter the chain)')
}

{
  // 一轮并行 2 个 tool_calls → 2 个节点，按 toolCall.id 各自映射结果
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1'), toolCall('c2', 'bash')], status: 'pending' })
  const t1 = toolResult('t1', 'c1', 'read_file')
  const t2 = toolResult('t2', 'c2', 'bash', 'boom', 'error')
  const rows = buildTimelineRows([a1, t1, t2], options)
  const row = rows[0]
  if (row.type !== 'chain') throw new Error('expected chain row')
  assert.deepEqual(row.nodes.map(node => [node.toolCallId, node.status]), [
    ['c1', 'done'],
    ['c2', 'error']
  ])
  assert.equal(row.nodes[1].isError, true)
}

{
  // 带正文的 assistant 轮保持 message 行原路径（含工具结果合并字段）
  const a1 = message({ id: 'a1', role: 'assistant', content: 'I will check', toolCalls: [toolCall('c1')], status: 'done' })
  const t1 = toolResult('t1', 'c1', 'read_file')
  const rows = buildTimelineRows([a1, t1], options)
  const row = rows[0]
  assert.equal(row.type, 'message', 'assistant with text keeps the message row path')
  if (row.type !== 'message') throw new Error('expected message row')
  assert.equal(row.toolStatuses?.['c1'], 'done')
  assert.equal(row.toolRevision, 't1:done')
}

{
  // 链尾追加成员：key 稳定 + revision 变化（memo 感知）
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1')], status: 'pending' })
  const a2 = message({ id: 'a2', role: 'assistant', toolCalls: [toolCall('c2')], status: 'pending' })
  const first = buildTimelineRows([a1], options)[0]
  if (first.type !== 'chain') throw new Error('expected chain row')
  const second = buildTimelineRows([a1, a2], options)[0]
  if (second.type !== 'chain') throw new Error('expected chain row')
  assert.equal(second.key, first.key, 'appending members must not change the chain row key')
  assert.notEqual(second.revision, first.revision, 'appending members must change the revision')
}

{
  // 结果落位 / 状态翻转 → revision 变化，key 不变
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1')], status: 'pending' })
  const noResult = buildTimelineRows([a1], options)[0]
  const withDone = buildTimelineRows([a1, toolResult('t1', 'c1', 'read_file')], options)[0]
  const withError = buildTimelineRows([a1, toolResult('t1', 'c1', 'read_file', 'bad', 'error')], options)[0]
  if (noResult.type !== 'chain' || withDone.type !== 'chain' || withError.type !== 'chain') {
    throw new Error('expected chain rows')
  }
  assert.equal(withDone.key, noResult.key)
  assert.equal(withError.key, noResult.key)
  assert.notEqual(withDone.revision, noResult.revision, 'result landing must change the revision')
  assert.notEqual(withError.revision, withDone.revision, 'status flip must change the revision')
}

{
  // 压缩边界落在链首成员上 → 链行之后紧跟压缩行
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1')], status: 'pending' })
  const t1 = toolResult('t1', 'c1', 'read_file')
  const after = message({ id: 'after', content: 'after' })
  const rows = buildTimelineRows([a1, t1, after], {
    ...options,
    compaction: { upToMessageId: 'a1' }
  })
  assert.deepEqual(rows.map(row => row.key), ['chain:a1', 'compaction:a1', 'message:after'])
}

{
  // 压缩边界落在被合并的 tool 结果上 → 仍要出压缩行（挂起标记路径）
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1')], status: 'pending' })
  const t1 = toolResult('t1', 'c1', 'read_file')
  const after = message({ id: 'after', content: 'after' })
  const rows = buildTimelineRows([a1, t1, after], {
    ...options,
    compaction: { upToMessageId: 't1' }
  })
  assert.deepEqual(rows.map(row => row.key), ['chain:a1', 'compaction:t1', 'message:after'])
}

{
  // 压缩边界落在链中间成员上 → 链在此断开：前段链行 + 压缩行 + 后段新链
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1')], status: 'pending' })
  const a2 = message({ id: 'a2', role: 'assistant', toolCalls: [toolCall('c2')], status: 'pending' })
  const a3 = message({ id: 'a3', role: 'assistant', toolCalls: [toolCall('c3')], status: 'pending' })
  const rows = buildTimelineRows([a1, a2, a3], {
    ...options,
    compaction: { upToMessageId: 'a2' }
  })
  assert.deepEqual(rows.map(row => row.key), ['chain:a1', 'compaction:a2', 'chain:a3'])
  const firstChain = rows[0]
  const secondChain = rows[2]
  if (firstChain.type !== 'chain' || secondChain.type !== 'chain') throw new Error('expected chain rows')
  assert.deepEqual(firstChain.members.map(m => m.id), ['a1', 'a2'], 'boundary member belongs to the first segment')
  assert.deepEqual(secondChain.members.map(m => m.id), ['a3'], 'rounds after the boundary start a new chain')
}

{
  // 孤儿 tool 消息不进链，仍单独可见
  const orphan = message({ id: 'orphan', role: 'tool', content: 'orphan', toolCallId: 'missing' })
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1')], status: 'pending' })
  const rows = buildTimelineRows([orphan, a1], options)
  assert.deepEqual(rows.map(row => row.key), ['message:orphan', 'chain:a1'])
}

{
  // 链行 + 重试行共存：running 会话尾部仍有 retry 行
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1')], status: 'pending' })
  const retryStatus = { failedAttempt: 1, maxRetries: 5 }
  const rows = buildTimelineRows([a1], { ...options, isRunning: true, retryStatus })
  assert.deepEqual(rows.map(row => row.key), ['chain:a1', 'retry:s1'])
}

// chain 行结构 sanity：members 与 nodes 平行可还原
{
  const a1 = message({ id: 'a1', role: 'assistant', toolCalls: [toolCall('c1', 'read_file'), toolCall('c2', 'bash')], status: 'pending' })
  const row = buildTimelineRows([a1], options)[0]
  if (row.type !== 'chain') throw new Error('expected chain row')
  const chainRow = row as ToolChainTimelineRow
  assert.deepEqual(chainRow.members.map(m => m.id), ['a1'])
  assert.deepEqual(chainRow.nodes.map(n => n.name), ['read_file', 'bash'])
  assert.ok(chainRow.nodes.every(n => n.arguments.includes('c')))
}

// ---------- buildToolChainNodes（单条消息并行调用的节点构建）----------
{
  const calls = [toolCall('c1', 'bash'), toolCall('c2', 'read'), toolCall('c3', 'read')]
  // 无结果 → 全部 running
  const running = buildToolChainNodes(calls, {}, {})
  assert.ok(running.every(node => node.status === 'running'))
  assert.deepEqual(running.map(node => node.toolCallId), ['c1', 'c2', 'c3'])

  // 部分结果 → 精确按 id 映射状态与内容
  const mixed = buildToolChainNodes(calls, { c1: 'done', c2: 'error' }, {
    c1: { content: 'ok', isError: false },
    c2: { content: 'boom', isError: true }
  })
  assert.deepEqual(mixed.map(node => [node.toolCallId, node.status]), [
    ['c1', 'done'],
    ['c2', 'error'],
    ['c3', 'running']
  ])
  assert.equal(mixed[1].content, 'boom')
  assert.equal(mixed[1].isError, true)
  assert.equal(mixed[2].content, undefined)

  // 缺 id 的调用被跳过
  const noId = buildToolChainNodes([{ id: '', type: 'function', function: { name: 'x', arguments: '' } }], {}, {})
  assert.deepEqual(noId, [])
}

console.log('renderer timeline projection tests passed')
