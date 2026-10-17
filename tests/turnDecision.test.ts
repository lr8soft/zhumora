// ============================================================
// turnDecision 状态机单元测试 — 直接 node 运行
//   node tests/turnDecision.test.ts
// 覆盖 runAgent 每轮 streamChat 返回后的终止/恢复决策。
// 这些是从 runner 抽出的纯函数，替代过去内联在 while 循环里、
// 与副作用交织的分支条件——恢复逻辑的正确性必须能脱离 LLM 验证。
//
// 两类"不完整本轮"共享恢复通路：
//   - finish_reason=length：单轮输出达到 max_tokens 上限
//   - streamInterrupted：流式响应中途被网络断开（已输出部分内容）
// 两者都按"不完整的本轮"处理，决策携带 cause 供日志/文案/UI 区分。
// ============================================================
import assert from 'node:assert/strict'
import { decideTurnOutcome, finalizationFailure, type TurnSignals } from '../src/main/agent/turnDecision.ts'

const base: TurnSignals = {
  finishReason: 'stop',
  toolCallCount: 0,
  toolCallsValid: true,
  contentEmpty: false,
  canRecoverTruncation: true,
  canRecoverEmptyResponse: true
}

// 1) 正常纯文本完成 → complete（无 cause）
assert.deepEqual(
  decideTurnOutcome({ ...base }),
  { kind: 'complete' },
  'finish_reason=stop 且有正文 → 正常完成'
)

// 2) 有工具调用且未截断 → execute_tools
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'tool_calls', toolCallCount: 2 }),
  { kind: 'execute_tools' },
  '未截断的工具轮 → 执行工具'
)

// 3) 截断(length) + 带工具 + 有预算 → recover_truncated_tool（绝不执行残缺参数）
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', toolCallCount: 1 }),
  { kind: 'recover_truncated_tool', cause: 'length' },
  'length 截断的工具轮优先走恢复，不执行残缺 JSON'
)

// 4) 截断(length) + 纯文本 + 有预算 → recover_truncated_text
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', toolCallCount: 0 }),
  { kind: 'recover_truncated_text', cause: 'length' },
  'length 截断的纯文本轮 → 续写'
)

// 5) 恢复耗尽是明确失败，不能把生成结束包装成任务交付。
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', canRecoverTruncation: false }),
  { kind: 'fail', cause: 'length' },
  'length 截断但预算耗尽 → 明确失败，防死循环'
)

// 6) 截断(length)带工具但预算耗尽：安全结束，绝不执行残缺调用。
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', toolCallCount: 1, canRecoverTruncation: false }),
  { kind: 'fail', cause: 'length' },
  'length 截断带工具但预算耗尽：安全结束且不执行'
)

// 7) 空响应（无正文无工具、非截断）+ 有预算 → recover_empty_response
assert.deepEqual(
  decideTurnOutcome({ ...base, contentEmpty: true }),
  { kind: 'recover_empty_response' },
  '空响应 → 注入继续指令'
)

// 8) 空响应 + 预算耗尽 → fail（不再空转，也不报告成功）
assert.deepEqual(
  decideTurnOutcome({ ...base, contentEmpty: true, canRecoverEmptyResponse: false }),
  { kind: 'fail', cause: 'empty' },
  '空响应但预算耗尽 → 明确失败，防空转和空成功'
)

// 9) 截断(length)的纯文本轮即便 content 为空也走续写（不完整优先于空响应判断）
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', contentEmpty: true }),
  { kind: 'recover_truncated_text', cause: 'length' },
  'length 不完整优先：空正文的截断轮仍续写而非当空响应'
)

// 10) 工具轮与正文是否为空无关
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'tool_calls', toolCallCount: 3, contentEmpty: true }),
  { kind: 'execute_tools' },
  '工具轮与正文是否为空无关'
)

// ============================================================
// 流中断（streamInterrupted）—— 与 length 截断同构
// ============================================================

// 11) 流中断 + 带工具 + 有预算 → recover_truncated_tool(cause=stream)
//     残缺的 tool_calls 参数同样不可信，绝不能执行
assert.deepEqual(
  decideTurnOutcome({ ...base, streamInterrupted: true, toolCallCount: 1 }),
  { kind: 'recover_truncated_tool', cause: 'stream' },
  '流中断的工具轮走恢复，不执行残缺 JSON（cause=stream）'
)

// 12) 流中断 + 纯文本 + 有预算 → recover_truncated_text(cause=stream)
assert.deepEqual(
  decideTurnOutcome({ ...base, streamInterrupted: true, toolCallCount: 0 }),
  { kind: 'recover_truncated_text', cause: 'stream' },
  '流中断的纯文本轮 → 续写（cause=stream）'
)

// 13) 流中断 + 预算耗尽 + 纯文本 → fail(cause=stream)
assert.deepEqual(
  decideTurnOutcome({ ...base, streamInterrupted: true, canRecoverTruncation: false }),
  { kind: 'fail', cause: 'stream' },
  '流中断但预算耗尽 → 明确失败（cause=stream）'
)

// 14) 流中断的纯文本轮即便 content 为空也走续写（不完整优先于空响应判断）
assert.deepEqual(
  decideTurnOutcome({ ...base, streamInterrupted: true, contentEmpty: true }),
  { kind: 'recover_truncated_text', cause: 'stream' },
  '流中断优先：空正文的中断轮仍续写而非当空响应'
)

// 15) 流中断 + 预算耗尽 + 带工具 → 安全结束（不执行）
assert.deepEqual(
  decideTurnOutcome({ ...base, streamInterrupted: true, toolCallCount: 1, canRecoverTruncation: false }),
  { kind: 'fail', cause: 'stream' },
  '流中断带工具但预算耗尽：安全结束且不执行'
)

// 16) length 与 stream 同时出现（理论上不该发生）时 length 优先
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', streamInterrupted: true }),
  { kind: 'recover_truncated_text', cause: 'length' },
  'length 与 stream 并存时 cause=length 优先'
)

// 17) 完整轮（无 length 无 stream）不受 streamInterrupted 字段缺失影响
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'stop', contentEmpty: false }),
  { kind: 'complete' },
  '正常完成不携带 cause'
)

// 18) 后端没有正确给出 length，但 arguments 已损坏 → 按不完整工具轮恢复
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'tool_calls', toolCallCount: 1, toolCallsValid: false }),
  { kind: 'recover_truncated_tool', cause: 'malformed' },
  'JSON 参数损坏时不信任 finish_reason，禁止执行'
)

// 19) malformed 恢复预算耗尽 → 安全结束，不能回落到执行路径
assert.deepEqual(
  decideTurnOutcome({
    ...base,
    finishReason: 'tool_calls',
    toolCallCount: 1,
    toolCallsValid: false,
    canRecoverTruncation: false
  }),
  { kind: 'fail', cause: 'malformed' },
  'JSON 参数损坏且恢复耗尽时安全结束'
)

for (const finishReason of [undefined, 'unknown', 'content_filter']) {
  assert.deepEqual(decideTurnOutcome({ ...base, finishReason }), { kind: 'fail', cause: 'finish_reason' })
}
for (const finishReason of ['unknown', 'content_filter']) {
  assert.deepEqual(decideTurnOutcome({ ...base, finishReason, streamInterrupted: true,
    toolCallCount: 1, toolCallsValid: false }), { kind: 'fail', cause: 'finish_reason' },
  'explicit abnormal termination must not be retried as malformed tools or stream recovery')
}
assert.deepEqual(decideTurnOutcome({ ...base, finishReason: 'stop', toolCallCount: 1 }), { kind: 'execute_tools' },
  'compatible providers may use stop with complete valid tool calls')
const final = { finishReason: 'stop', streamInterrupted: false, toolCallCount: 0, contentEmpty: false }
assert.equal(finalizationFailure(final), null)
assert.equal(finalizationFailure({ ...final, contentEmpty: true }), 'empty')
assert.equal(finalizationFailure({ ...final, streamInterrupted: true }), 'stream')
assert.equal(finalizationFailure({ ...final, finishReason: 'length' }), 'length')
assert.equal(finalizationFailure({ ...final, toolCallCount: 1 }), 'unexpected_tools')
assert.equal(finalizationFailure({ ...final, finishReason: 'content_filter' }), 'finish_reason')
console.log('turnDecision state machine tests passed')
