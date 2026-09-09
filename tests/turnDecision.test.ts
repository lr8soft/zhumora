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
import { decideTurnOutcome, type TurnSignals } from '../src/main/agent/turnDecision.ts'

const base: TurnSignals = {
  finishReason: 'stop',
  toolCallCount: 0,
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

// 5) 截断(length) + 预算耗尽 + 纯文本 → complete（带 truncatedNotice），不再重试
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', canRecoverTruncation: false }),
  { kind: 'complete', truncatedNotice: true, cause: 'length' },
  'length 截断但预算耗尽 → 收尾并提示，防死循环'
)

// 6) 截断(length)带工具但预算耗尽：落入 execute_tools 之外的安全路径。
//    关键：截断的工具轮即使预算耗尽，也不能走恢复（无预算）；
//    这里确认它不会误判为可安全恢复的 complete。
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', toolCallCount: 1, canRecoverTruncation: false }),
  { kind: 'execute_tools' },
  'length 截断带工具但预算耗尽：由 runner 的执行层再兜底（参数非法 JSON 会被拒）'
)

// 7) 空响应（无正文无工具、非截断）+ 有预算 → recover_empty_response
assert.deepEqual(
  decideTurnOutcome({ ...base, contentEmpty: true }),
  { kind: 'recover_empty_response' },
  '空响应 → 注入继续指令'
)

// 8) 空响应 + 预算耗尽 → complete（不再空转）
assert.deepEqual(
  decideTurnOutcome({ ...base, contentEmpty: true, canRecoverEmptyResponse: false }),
  { kind: 'complete' },
  '空响应但预算耗尽 → 完成，防空转'
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

// 13) 流中断 + 预算耗尽 + 纯文本 → complete(truncatedNotice, cause=stream)
assert.deepEqual(
  decideTurnOutcome({ ...base, streamInterrupted: true, canRecoverTruncation: false }),
  { kind: 'complete', truncatedNotice: true, cause: 'stream' },
  '流中断但预算耗尽 → 收尾并提示（cause=stream）'
)

// 14) 流中断的纯文本轮即便 content 为空也走续写（不完整优先于空响应判断）
assert.deepEqual(
  decideTurnOutcome({ ...base, streamInterrupted: true, contentEmpty: true }),
  { kind: 'recover_truncated_text', cause: 'stream' },
  '流中断优先：空正文的中断轮仍续写而非当空响应'
)

// 15) 流中断 + 预算耗尽 + 带工具 → execute_tools（同 length 的兜底语义）
assert.deepEqual(
  decideTurnOutcome({ ...base, streamInterrupted: true, toolCallCount: 1, canRecoverTruncation: false }),
  { kind: 'execute_tools' },
  '流中断带工具但预算耗尽：由 runner 执行层兜底（参数非法 JSON 会被拒）'
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

console.log('turnDecision state machine tests passed')
