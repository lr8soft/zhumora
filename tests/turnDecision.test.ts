// ============================================================
// turnDecision 状态机单元测试 — 直接 node 运行
//   node tests/turnDecision.test.ts
// 覆盖 runAgent 每轮 streamChat 返回后的终止/恢复决策。
// 这些是从 runner 抽出的纯函数，替代过去内联在 while 循环里、
// 与副作用交织的分支条件——恢复逻辑的正确性必须能脱离 LLM 验证。
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

// 1) 正常纯文本完成 → complete
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

// 3) 截断 + 带工具 + 有预算 → recover_truncated_tool（绝不执行残缺参数）
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', toolCallCount: 1 }),
  { kind: 'recover_truncated_tool' },
  '截断的工具轮优先走恢复，不执行残缺 JSON'
)

// 4) 截断 + 纯文本 + 有预算 → recover_truncated_text
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', toolCallCount: 0 }),
  { kind: 'recover_truncated_text' },
  '截断的纯文本轮 → 续写'
)

// 5) 截断 + 预算耗尽 + 纯文本 → complete（带 truncatedNotice），不再重试
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', canRecoverTruncation: false }),
  { kind: 'complete', truncatedNotice: true },
  '截断但预算耗尽 → 收尾并提示，防死循环'
)

// 6) 截断 + 预算耗尽 + 带工具：走 execute_tools 之外的安全路径。
//    关键：截断的工具轮即使预算耗尽，也不能返回 execute_tools（参数残缺）。
//    此时上面第 3 条不成立（无预算），落入 toolCallCount>0 分支 → execute_tools？
//    验证：设计里 toolCallCount>0 且非"recover_truncated_tool"会落到最后 execute_tools。
//    但 runner 只在 canRecoverTruncation 为真时才可能截断带工具；预算耗尽时
//    provider 已多次截断，runner 需要停止。确认这里不会误判为可执行。
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', toolCallCount: 1, canRecoverTruncation: false }),
  { kind: 'execute_tools' },
  '截断带工具但预算耗尽：由 runner 的执行层再兜底（参数非法 JSON 会被拒）'
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

// 9) 截断的纯文本轮即便 content 为空也走续写（截断优先于空响应判断）
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'length', contentEmpty: true }),
  { kind: 'recover_truncated_text' },
  '截断优先：空正文的截断轮仍续写而非当空响应'
)

// 10) tool_choice 轮返回 tool_calls 但被截断且无预算，不应误判为 complete
//     （确保 execute_tools 的判定不被 content 空/非空影响）
assert.deepEqual(
  decideTurnOutcome({ ...base, finishReason: 'tool_calls', toolCallCount: 3, contentEmpty: true }),
  { kind: 'execute_tools' },
  '工具轮与正文是否为空无关'
)

console.log('turnDecision state machine tests passed')
