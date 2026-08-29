// ============================================================
// sseAccumulator 单元测试 — 直接 node 运行（Node 22+ type stripping）
//   node tests/truncation.test.ts
// 覆盖"单轮输出被 max_tokens 截断"修复的核心数据通路：
//   网络块 → SseLineBuffer 行切分 → applySseData 聚合 → finishReason 信号
// ============================================================
import { createStreamAccumulator, applySseData, accumulateResult, SseLineBuffer } from '../src/main/llm/sseAccumulator.ts'

let passed = 0
let failed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}
function assertEq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
}

// ---- 辅助：把一批 SSE 文本行喂进聚合器（模拟一个完整流）----
function runStream(acc: ReturnType<typeof createStreamAccumulator>, sseLines: string[]): void {
  for (const line of sseLines) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : line
    applySseData(acc, data)
  }
}

// ============================================================
console.log('\napplySseData — 文本与 finish_reason')
// ============================================================

test('文本增量拼接 + finish_reason 捕获', () => {
  const acc = createStreamAccumulator()
  runStream(acc, [
    '{"choices":[{"delta":{"content":"Hel"},"index":0}]}',
    '{"choices":[{"delta":{"content":"lo"},"index":0}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}],"index":0}'
  ])
  const r = accumulateResult(acc)
  assertEq(r.content, 'Hello', 'content')
  assertEq(r.finishReason, 'stop', 'finishReason')
})

test('finish_reason=length（被 max_tokens 截断的信号）', () => {
  const acc = createStreamAccumulator()
  runStream(acc, [
    '{"choices":[{"delta":{"content":"partial outp"},"index":0}]}',
    '{"choices":[{"delta":{"content":"ut"},"index":0}]}',
    '{"choices":[{"delta":{},"finish_reason":"length"}],"index":0}'
  ])
  assertEq(accumulateResult(acc).finishReason, 'length', 'finishReason')
})

test('最后一个非空 finish_reason 生效（部分后端中间块也带空 finish_reason）', () => {
  const acc = createStreamAccumulator()
  runStream(acc, [
    '{"choices":[{"delta":{"content":"a"},"finish_reason":null}]}',
    '{"choices":[{"delta":{"content":"b"},"finish_reason":null}]}',
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'
  ])
  assertEq(accumulateResult(acc).finishReason, 'tool_calls', 'finishReason')
})

test('usage 捕获（末块携带、choices 为空数组）', () => {
  const acc = createStreamAccumulator()
  runStream(acc, [
    '{"choices":[{"delta":{"content":"hi"},"index":0}]}',
    '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}'
  ])
  const u = accumulateResult(acc).usage
  assert(u, 'usage 存在')
  assertEq(u!.prompt_tokens, 10, 'prompt_tokens')
  assertEq(u!.completion_tokens, 3, 'completion_tokens')
  assertEq(u!.total_tokens, 13, 'total_tokens')
})

test('[DONE]、非 JSON 行、keep-alive 注释行被安全忽略', () => {
  const acc = createStreamAccumulator()
  runStream(acc, [
    '[DONE]',
    'not-json-at-all',
    '',
    '{"choices":[{"delta":{"content":"ok"},"index":0}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}'
  ])
  const r = accumulateResult(acc)
  assertEq(r.content, 'ok', 'content')
  assertEq(r.finishReason, 'stop', 'finishReason')
})

// ============================================================
console.log('\napplySseData — 工具调用分片拼接')
// ============================================================

test('单工具调用分片拼接（id/name/arguments 分块到达）', () => {
  const acc = createStreamAccumulator()
  runStream(acc, [
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"wri","arguments":"{\\"fi"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"te","arguments":"le_path\\":\\"/a"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".txt\\"}"}}]}}]}',
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'
  ])
  const r = accumulateResult(acc)
  assertEq(r.toolCalls.length, 1, 'toolCalls 数量')
  assertEq(r.toolCalls[0].id, 'call_1', 'id')
  assertEq(r.toolCalls[0].function.name, 'write', 'name 拼接')
  assertEq(r.toolCalls[0].function.arguments, '{"file_path":"/a.txt"}', 'arguments 拼接')
  assertEq(r.finishReason, 'tool_calls', 'finishReason')
})

test('并行工具调用按 index 独立组装', () => {
  const acc = createStreamAccumulator()
  runStream(acc, [
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{\\"p\\":1}"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"grep","arguments":"{\\"q\\":2}"}}]}}]}',
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'
  ])
  const r = accumulateResult(acc)
  assertEq(r.toolCalls.length, 2, 'toolCalls 数量')
  assertEq(r.toolCalls[0].function.name, 'read', 'index 0')
  assertEq(r.toolCalls[1].function.name, 'grep', 'index 1')
})

test('截断的工具调用：arguments 是不完整 JSON（修复要识别的场景）', () => {
  const acc = createStreamAccumulator()
  runStream(acc, [
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write","arguments":"{\\"file_path\\":\\"/big\\","}}]}}]}',
    '{"choices":[{"delta":{},"finish_reason":"length"}]}'
  ])
  const r = accumulateResult(acc)
  assertEq(r.finishReason, 'length', 'finishReason=length')
  assertEq(r.toolCalls.length, 1, '有 1 个（残缺的）工具调用')
  let parsed = 'ok'
  try { JSON.parse(r.toolCalls[0].function.arguments) } catch { parsed = 'broken' }
  assertEq(parsed, 'broken', 'arguments 确实不完整（原样保留，由 runner 层拒绝执行）')
})

test('emitted 标记：文本/工具调用块为 true，纯 usage 块为 false', () => {
  const acc = createStreamAccumulator()
  assertEq(applySseData(acc, '{"choices":[{"delta":{"content":"x"},"index":0}]}').emitted, true, '文本')
  assertEq(applySseData(acc, '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"i","function":{"name":"n","arguments":"{}"}}]}}]}').emitted, true, '工具调用')
  assertEq(applySseData(acc, '{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}').emitted, false, 'usage')
  assertEq(applySseData(acc, '[DONE]').emitted, false, 'DONE')
  assertEq(applySseData(acc, 'garbage').emitted, false, '非法 JSON')
})

// ============================================================
console.log('\nSseLineBuffer — 网络块切分行')
// ============================================================

test('跨网络块的不完整行正确拼接', () => {
  const buf = new SseLineBuffer()
  const lines: string[] = []
  const full = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n'
  // 模拟 TCP 分块：一行被切成 3 段
  buf.feed(full.slice(0, 4), l => lines.push(l))
  buf.feed(full.slice(4, 12), l => lines.push(l))
  buf.feed(full.slice(12), l => lines.push(l))
  buf.flush(l => lines.push(l))
  assertEq(lines.length, 1, '只回调一次')
  assertEq(lines[0].trim(), 'data: {"choices":[{"delta":{"content":"Hello"}}]}', '完整行')
})

test('多行 + 末行无换行（flush 兜底）', () => {
  const buf = new SseLineBuffer()
  const lines: string[] = []
  buf.feed('data: a\ndata: b', l => lines.push(l))   // 第二行无结尾换行
  buf.flush(l => lines.push(l))
  assertEq(lines.length, 2, '两行')
  assertEq(lines[0], 'data: a', '第一行')
  assertEq(lines[1], 'data: b', '末行经 flush 补出')
})

test('空块 / flush 无剩余不产生回调', () => {
  const buf = new SseLineBuffer()
  const lines: string[] = []
  buf.feed('data: x\n', l => lines.push(l))
  buf.feed('', l => lines.push(l))
  buf.flush(l => lines.push(l))
  assertEq(lines.length, 1, '仅一行')
})

// ============================================================
console.log('\n端到端：完整 SSE 流（含末块无换行）')
// ============================================================

test('模拟真实流：分块到达 + 末块无换行 → finish_reason/usage 不丢', () => {
  const acc = createStreamAccumulator()
  const buf = new SseLineBuffer()
  let emitted = false
  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const applied = applySseData(acc, trimmed.slice(5).trim())
    if (applied.emitted) emitted = true
  }
  const chunks = [
    'data: {"choices":[{"delta":{"content":"让我"},"index":0}]}',
    '\ndata: {"choices":[{"delta":{"content":"写文件"},"index":0}]}',
    '\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"z1","function":{"name":"write","arguments":"{\\"file"}}]}}]}',
    '\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\\":\\"x\\"}"}}]}}]}',
    '\n', // 空行
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":42,"total_tokens":142}}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}],"index":0}'  // 末块无换行
  ]
  for (const c of chunks) buf.feed(c, handleLine)
  buf.flush(handleLine)

  const r = accumulateResult(acc)
  assertEq(r.content, '让我写文件', 'content')
  assertEq(r.toolCalls.length, 1, 'toolCalls')
  assertEq(r.toolCalls[0].function.name, 'write', 'name')
  assertEq(r.toolCalls[0].function.arguments, '{"file_path":"x"}', 'arguments')
  assertEq(r.finishReason, 'length', 'finishReason（末块无换行也不丢）')
  assertEq(r.usage?.total_tokens, 142, 'usage（末块前一块）')
  assertEq(emitted, true, '有可见输出 → 不重试')
})

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
