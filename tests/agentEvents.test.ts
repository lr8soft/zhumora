// ============================================================
// agentEvents reducer 单元测试 — 直接 node 运行
//   node tests/agentEvents.test.ts
// 覆盖消息协议（AGENTS.MD 验证清单）：
//   - 只按 main 权威 ID 归并，不回退"最后一条 streaming"
//   - start 先于 token 的替换语义 / 思考占位保留
//   - 纯工具轮空气泡移除 / 工具结果按 ID 追加
//   - token 批量增量精确命中、终态不被改写
// ============================================================
import assert from 'node:assert/strict'
import type { UIMessage, ToolCall } from '../src/shared/types'
import {
  applyAssistantStart,
  applyAssistantEnd,
  applyToolCallEvent,
  applyToolResultEvent,
  applyTokenDeltas
} from '../src/renderer/src/agentEvents.ts'

const NOW = 1_700_000_000_000
const msg = (over: Partial<UIMessage> & { id: string }): UIMessage => ({
  sessionId: 's1', role: 'assistant', content: '', timestamp: NOW, ...over
})
const toolCall = (id: string, name = 'read'): ToolCall => ({
  id, type: 'function', function: { name, arguments: '{}' }
})

// ---- applyAssistantStart ----
{
  // thinking 占位被替换为正式流式消息，且保留占位期间已累积的思考内容
  const withPlaceholder = [msg({ id: 'thinking-1', status: 'thinking', reasoning: 'hmm' })]
  const out = applyAssistantStart('s1', 'm1', withPlaceholder, NOW)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'm1')
  assert.equal(out[0].status, 'streaming')
  assert.equal(out[0].reasoning, 'hmm', '保留占位期间的思考内容（防御事件乱序）')

  // 无占位：追加；同一 ID 重复 start 幂等
  const appended = applyAssistantStart('s1', 'm2', [], NOW)
  assert.equal(appended.length, 1)
  assert.equal(applyAssistantStart('s1', 'm2', appended, NOW), appended, '重复 start 返回原引用')
}

// ---- applyAssistantEnd ----
{
  // 纯工具轮：start 建的空气泡在 end（无文本无思考无工具）时移除
  const streaming = [msg({ id: 'm1', status: 'streaming' })]
  assert.deepEqual(applyAssistantEnd('s1', 'm1', '', [], undefined, streaming, NOW), [], '空气泡移除')

  // 有工具调用：status=pending，工具列表写入
  const calls = [toolCall('c1')]
  const ended = applyAssistantEnd('s1', 'm1', '', calls, undefined, streaming, NOW)
  assert.equal(ended[0].status, 'pending')
  assert.equal(ended[0].toolCalls!.length, 1)

  // end 事件的权威 reasoning 覆盖 UI 累积值
  const withStreamed = [msg({ id: 'm1', status: 'streaming', content: 'part', reasoning: 'partial' })]
  const final = applyAssistantEnd('s1', 'm1', 'full answer', [], 'complete reasoning', withStreamed, NOW)
  assert.equal(final[0].content, 'full answer')
  assert.equal(final[0].reasoning, 'complete reasoning')
  assert.equal(final[0].status, 'done')

  // 消息不存在（renderer 错过 start）：空内容 end 忽略、非空补建
  assert.equal(applyAssistantEnd('s1', 'mx', '', [], undefined, [], NOW).length, 0)
  const rebuilt = applyAssistantEnd('s1', 'mx', 'hello', [], undefined, [], NOW)
  assert.equal(rebuilt[0].id, 'mx')
  assert.equal(rebuilt[0].status, 'done')
}

// ---- applyToolCallEvent ----
{
  const base = [msg({ id: 'm1', status: 'streaming' }), msg({ id: 'thinking-2', status: 'thinking' })]
  const out = applyToolCallEvent('s1', 'm1', toolCall('c1'), base, NOW)
  assert.equal(out.some(x => x.status === 'thinking'), false, '工具开始时移除 thinking 占位')
  assert.equal(out.find(x => x.id === 'm1')!.toolCalls!.length, 1)

  // 同一 call id 重复事件幂等（不重复挂）
  const again = applyToolCallEvent('s1', 'm1', toolCall('c1'), out, NOW)
  assert.equal(again.find(x => x.id === 'm1')!.toolCalls!.length, 1)

  // 按 ID 找不到 → 补建 pending 消息（不是挂到最后一条！）
  const orphan = applyToolCallEvent('s1', 'm9', toolCall('c9'), [msg({ id: 'm1', status: 'done' })], NOW)
  assert.equal(orphan.length, 2)
  assert.equal(orphan[1].id, 'm9')
  assert.equal(orphan[1].status, 'pending')
  assert.equal(orphan[0].status, 'done', '其他消息不受影响（不按位置猜测）')
}

// ---- applyToolResultEvent ----
{
  const out = applyToolResultEvent('s1', 'tr1', 'c1', 'read', 'file contents', false, [], NOW)
  assert.equal(out[0].id, 'tr1')
  assert.equal(out[0].role, 'tool')
  assert.equal(out[0].status, 'done')
  const err = applyToolResultEvent('s1', 'tr2', 'c2', 'bash', 'boom', true, [], NOW)
  assert.equal(err[0].status, 'error')
}

// ---- applyTokenDeltas ----
{
  const msgs = [
    msg({ id: 'm1', status: 'streaming', content: 'a' }),
    msg({ id: 'm2', status: 'done', content: 'final' }),
    msg({ id: 'm3', status: 'thinking', reasoning: 'r' })
  ]
  const out = applyTokenDeltas(msgs, [
    { msgId: 'm1', content: 'bc', reasoning: '' },
    { msgId: 'm2', content: 'x', reasoning: '' },
    { msgId: 'm3', content: '', reasoning: 'r2' },
    { msgId: 'unknown', content: 'ignored', reasoning: '' },
    { msgId: 'm1', content: '', reasoning: '' }
  ])
  assert.equal(out.find(x => x.id === 'm1')!.content, 'abc', '增量按 ID 精确追加')
  assert.equal(out.find(x => x.id === 'm2')!.status, 'done', 'done 终态不被 token 改回 streaming')
  assert.equal(out.find(x => x.id === 'm3')!.reasoning, 'rr2')
  assert.equal(out.find(x => x.id === 'm3')!.status, 'streaming', 'thinking 收到增量转 streaming')
  assert.equal(out.find(x => x.id === 'unknown'), undefined)

  // 无有效增量返回原引用（不触发无谓重渲染）
  assert.equal(applyTokenDeltas(msgs, [{ msgId: 'm1', content: '', reasoning: '' }]), msgs)
}

console.log('agentEvents reducer tests passed')
