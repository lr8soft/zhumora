// ============================================================
// history.ts 单元测试 — 直接 node 运行（Node 22+ type stripping）
//   npx tsx tests/history.test.ts  或  node tests/history.test.ts
// ============================================================
import { splitAtSafeBoundary, sanitizeHistory, sanitizeHistoryWithIds, planCompact, planCompactByTokens, buildEffectiveConversation, type CompactionState } from '../src/main/agent/history.ts'
import { COMPACT_SUMMARY_PREFIX } from '../src/shared/types.ts'
import type { ChatMessage, ToolCall } from '../src/shared/types.ts'

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
  if (a !== b) throw new Error(`${msg} — got ${a}, want ${b}`)
}

// ---- 构造辅助 ----
const text = (role: ChatMessage['role'], content: string): ChatMessage =>
  ({ role, content })

const tc = (id: string, name: string): ToolCall =>
  ({ id, type: 'function', function: { name, arguments: '{}' } })

const assistantWithCalls = (...calls: ToolCall[]): ChatMessage =>
  ({ role: 'assistant', content: null, tool_calls: calls })

const toolResult = (id: string, name: string, content: string): ChatMessage =>
  ({ role: 'tool', content, tool_call_id: id, name })

/** 校验消息序列是否满足 OpenAI tool 消息协议 */
function validateSequence(msgs: ChatMessage[]): string[] {
  const errors: string[] = []
  const open = new Map<string, string>() // callId -> assistant 下标
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const c of m.tool_calls) open.set(c.id, String(i))
    } else if (m.role === 'tool') {
      if (!m.tool_call_id || !open.has(m.tool_call_id)) {
        errors.push(`msg[${i}]: orphan tool result (tool_call_id=${m.tool_call_id})`)
      } else {
        open.delete(m.tool_call_id)
      }
    }
  }
  for (const [id, idx] of open) {
    errors.push(`msg[${idx}]: assistant tool_call ${id} missing result`)
  }
  return errors
}

function makeLongHistory(): ChatMessage[] {
  // 构造一段较长历史，穿插工具轮次，用于测试切分边界
  const msgs: ChatMessage[] = [
    text('user', '帮我看看项目结构'),
    assistantWithCalls(tc('c1', 'ls')),
    toolResult('c1', 'ls', 'src/ out/'),
    assistantWithCalls(tc('c2', 'read')),
    toolResult('c2', 'read', '...code...'),
    text('assistant', '项目包含 src 目录。'),
    text('user', '再帮我改一下配置'),
    assistantWithCalls(tc('c3', 'edit')),
    toolResult('c3', 'edit', 'edited'),
    assistantWithCalls(tc('c4', 'bash')),
    toolResult('c4', 'bash', 'ok'),
    text('user', '然后跑一下测试'),
    assistantWithCalls(tc('c5', 'bash')),
    toolResult('c5', 'bash', 'passed'),
    text('assistant', '测试通过。'),
  ]
  return msgs
}

// ============================================================
console.log('\nsplitAtSafeBoundary')
// ============================================================

test('切点落在 tool 消息上 → 回退到对应 assistant（整组保留）', () => {
  const msgs = makeLongHistory()
  // 实际布局: 0=user 1=assistant(c1) 2=tool(c1) 3=assistant(c2) 4=tool(c2)
  assertEq(msgs[2].role, 'tool', '前置条件')
  const idx = splitAtSafeBoundary(msgs, 2)
  assertEq(idx, 1, '应回退到 assistant 消息下标 1')
})

test('切点正好在 assistant(tool_calls) 之后 → 回退一条', () => {
  const msgs = makeLongHistory()
  // 布局: 6=user 7=assistant(c3) 8=tool(c3)
  assertEq(msgs[7].role, 'assistant', '前置条件')
  assertEq(msgs[8].role, 'tool', '前置条件')
  const idx = splitAtSafeBoundary(msgs, 8)
  assertEq(idx, 7, '应回退到 assistant 消息下标 7')
})

test('切点落在普通消息上 → 原地切分', () => {
  const msgs = makeLongHistory()
  // msgs[5] = assistant 纯文本
  const idx = splitAtSafeBoundary(msgs, 5)
  assertEq(idx, 5, '纯文本 assistant 可直接切')
})

test('切点回退后不会越过更早的悬空组（连续工具组）', () => {
  // user → assistant(c1,c2 并行) → tool(c1) → tool(c2)
  const msgs: ChatMessage[] = [
    text('user', 'hi'),
    assistantWithCalls(tc('c1', 'a'), tc('c2', 'b')),
    toolResult('c1', 'a', 'r1'),
    toolResult('c2', 'b', 'r2'),
  ]
  const idx = splitAtSafeBoundary(msgs, 3) // 落在 tool(c2)
  assertEq(idx, 1, '应回退到并行调用的 assistant')
})

// ============================================================
console.log('\nsanitizeHistory')
// ============================================================

test('完整合法序列 → 原样保留', () => {
  const msgs = makeLongHistory()
  const out = sanitizeHistory(msgs)
  assertEq(out.length, msgs.length, '长度不变')
  assertEq(validateSequence(out).length, 0, '序列合法')
})

test('悬空 tool_call 组（abort 残留：有调用无结果）→ 整组删除', () => {
  const msgs: ChatMessage[] = [
    text('user', 'hi'),
    text('assistant', '好的'),
    assistantWithCalls(tc('c9', 'bash')), // 执行前崩溃，无结果
    text('user', '再来一次'),
  ]
  const out = sanitizeHistory(msgs)
  assertEq(out.length, 3, '悬空组被删除')
  assert(!out.some(m => m.tool_calls?.some(c => c.id === 'c9')), 'c9 组不存在')
  assertEq(validateSequence(out).length, 0, '序列合法')
})

test('悬空组只有部分结果 → 整组删除（含已有结果）', () => {
  const msgs: ChatMessage[] = [
    text('user', 'hi'),
    assistantWithCalls(tc('c1', 'a'), tc('c2', 'b')),
    toolResult('c1', 'a', 'r1'), // c2 缺结果
    text('user', 'next'),
  ]
  const out = sanitizeHistory(msgs)
  assertEq(out.length, 2, '整组删除')
  assertEq(validateSequence(out).length, 0, '序列合法')
})

test('孤儿 tool 结果（前面无对应调用）→ 删除', () => {
  const msgs: ChatMessage[] = [
    text('user', 'hi'),
    toolResult('ghost', 'bash', '???'), // 孤儿
    text('assistant', 'hello'),
  ]
  const out = sanitizeHistory(msgs)
  assertEq(out.length, 2, '孤儿被删除')
  assertEq(validateSequence(out).length, 0, '序列合法')
})

test('空 assistant（无 content 无 tool_calls）→ 删除', () => {
  const msgs: ChatMessage[] = [
    text('user', 'hi'),
    { role: 'assistant', content: null },
    text('assistant', 'hello'),
  ]
  const out = sanitizeHistory(msgs)
  assertEq(out.length, 2, '空 assistant 被删除')
})

test('典型恢复场景：上一轮 abort 后新 user 消息 → 序列合法', () => {
  // DB 里实际会存的样子：...tool轮... assistant(tool_calls) [abort] user 新消息
  const msgs: ChatMessage[] = [
    text('user', '第一步'),
    assistantWithCalls(tc('c1', 'read')),
    toolResult('c1', 'read', 'file content'),
    text('assistant', '读完了'),
    assistantWithCalls(tc('c2', 'write')), // abort 在这里
    text('user', '继续吧'),
  ]
  const out = sanitizeHistory(msgs)
  assertEq(validateSequence(out).length, 0, '清洗后序列合法')
  assert(out.some(m => m.role === 'user' && m.content === '继续吧'), '新用户消息保留')
})

// ============================================================
console.log('\nplanCompact')
// ============================================================

test('切分后 toKeep 开头合法，且拼接还原原序列', () => {
  const msgs = makeLongHistory()
  const { toCompress, toKeep } = planCompact(msgs, 4)
  assert(toCompress.length > 0, '有可压缩部分')
  // toKeep 自身（去掉前面的 system 语义后）必须合法
  assertEq(validateSequence(toKeep).length, 0, 'toKeep 开头合法')
  const merged = [...toCompress, ...toKeep]
  assertEq(merged.length, msgs.length, '拼接长度 = 原序列')
  for (let i = 0; i < msgs.length; i++) {
    assert(merged[i] === msgs[i], `msg[${i}] 是同一引用`)
  }
})

test('模拟完整 compact 流程：压缩摘要 + toKeep 重排后序列合法', () => {
  const msgs = makeLongHistory()
  const { toCompress, toKeep } = planCompact(msgs, 4)
  // 模拟 autoCompact 的产物：system + [摘要] + toKeep
  const compacted: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    text('user', '[Auto Compact Summary]\n之前讨论了项目结构'),
    ...toKeep,
  ]
  assertEq(validateSequence(compacted).length, 0, '重排后序列合法（不 400）')
})

test('消息太少 → 不压缩', () => {
  const msgs: ChatMessage[] = [
    text('user', 'hi'),
    text('assistant', 'hello'),
  ]
  const { toCompress, toKeep } = planCompact(msgs, 8)
  assertEq(toCompress.length, 0, '无压缩')
  assertEq(toKeep.length, 2, '全部保留')
})

test('keepRecent 切点恰好把 assistant 组切断 → 自动扩展保留', () => {
  // 12 条消息，keep=4 → 裸切点 8 落在 tool 上
  const msgs: ChatMessage[] = [
    text('user', 'u1'),
    text('assistant', 'a1'),
    text('user', 'u2'),
    text('assistant', 'a2'),
    text('user', 'u3'),
    text('assistant', 'a3'),
    text('user', 'u4'),
    assistantWithCalls(tc('cx', 'bash')), // idx 7
    toolResult('cx', 'bash', 'done'),     // idx 8 ← 裸切点
    text('user', 'u5'),
    text('assistant', 'a5'),
    text('user', 'u6'),
  ]
  const { toCompress, toKeep } = planCompact(msgs, 4)
  assertEq(toKeep[0], msgs[7], '切点回退到 assistant 组起点')
  assertEq(validateSequence(toKeep).length, 0, 'toKeep 合法')
})

test('切点回退到序列起点 → 放弃切分（返回 0）', () => {
  // 序列开头就是一个工具组，切点落在它的 tool 结果上
  const msgs: ChatMessage[] = [
    assistantWithCalls(tc('c1', 'a')), // idx 0
    toolResult('c1', 'a', 'r1'),       // idx 1
    text('user', 'u2'),
    text('assistant', 'a2'),
    text('user', 'u3'),
    text('assistant', 'a3'),
    text('user', 'u4'),
    text('assistant', 'a4'),
  ]
  const idx = splitAtSafeBoundary(msgs, 1)
  assertEq(idx, 0, '回退到 0 = 放弃切分')
})

test('planCompact：整个序列是一个并行工具组 → 放弃压缩', () => {
  // 1 个 assistant 发起 20 个并行调用 + 20 条结果 = 21 条消息
  // keep=8 → 裸切点 13 落在 tool 上，回退到 idx 0 → 放弃切分
  const calls = Array.from({ length: 20 }, (_, i) => tc(`c${i}`, `t${i}`))
  const msgs: ChatMessage[] = [
    assistantWithCalls(...calls),
    ...Array.from({ length: 20 }, (_, i) => toolResult(`c${i}`, `t${i}`, `r${i}`)),
  ]
  const { toCompress, toKeep } = planCompact(msgs, 8)
  assertEq(toCompress.length, 0, '放弃压缩')
  assertEq(toKeep.length, msgs.length, '全部保留')
})

test('planCompact：长序列含工具组 → 正常压缩且 toKeep 合法', () => {
  const msgs: ChatMessage[] = [
    text('user', 'u1'),
    assistantWithCalls(tc('c1', 'a')), // idx 1
    toolResult('c1', 'a', 'r1'),       // idx 2
    ...Array.from({ length: 18 }, (_, i) =>
      i % 2 === 0 ? text('user', `u${i}`) : text('assistant', `a${i}`)
    ),
  ]
  const { toCompress, toKeep } = planCompact(msgs, 8)
  assert(toCompress.length > 0, '正常压缩')
  assertEq(validateSequence(toKeep).length, 0, 'toKeep 合法')
  const merged = [...toCompress, ...toKeep]
  assertEq(merged.length, msgs.length, '拼接还原')
})

// ============================================================
console.log('\nplanCompactByTokens')
// ============================================================

/** 测试用 token 估算：content 字符数 / 4（足够稳定即可，不要求精确） */
const tokenEstimator = (m: ChatMessage): number => {
  const text = typeof m.content === 'string' ? m.content.length : (m.content ? JSON.stringify(m.content).length : 0)
  return Math.ceil(text / 4) + 4
}

test('按 token 预算切分：保留部分 token 接近预算', () => {
  const msgs: ChatMessage[] = []
  for (let i = 0; i < 30; i++) {
    msgs.push(text('user', `第 ${i} 步：执行操作`))
    msgs.push(assistantWithCalls(tc(`c${i}`, 'read')))
    msgs.push(toolResult(`c${i}`, 'read', 'X'.repeat(4000))) // ~1000 tokens/条
  }
  const { toCompress, toKeep } = planCompactByTokens(msgs, 6000, tokenEstimator)
  assert(toCompress.length > 0, '有可压缩部分')
  const keepTokens = toKeep.reduce((s, m) => s + tokenEstimator(m), 0)
  assert(keepTokens >= 4000, `保留 token 应达到预算量级 (got ${keepTokens})`)
  assert(keepTokens < 12000, `保留 token 不应远超预算 (got ${keepTokens})`)
  assertEq(toCompress.length + toKeep.length, msgs.length, '拼接还原')
  assertEq(validateSequence(toKeep).length, 0, 'toKeep 合法')
})

test('切点对齐安全边界：不落在 assistant 与其 tool 结果之间', () => {
  // 预算恰好在某工具组中间 → 应回退到该组 assistant 起点
  const msgs: ChatMessage[] = []
  for (let i = 0; i < 20; i++) {
    msgs.push(text('user', `u${i}`))
    msgs.push(assistantWithCalls(tc(`c${i}`, 't')))
    msgs.push(toolResult(`c${i}`, 't', 'Y'.repeat(3000)))
  }
  const { toKeep } = planCompactByTokens(msgs, 5000, tokenEstimator)
  // toKeep 首条不能是孤儿 tool 结果
  assert(toKeep[0].role !== 'tool', `toKeep 首条不是悬空 tool (got ${toKeep[0].role})`)
  assertEq(validateSequence(toKeep).length, 0, 'toKeep 合法')
})

test('消息太少 → 不压缩', () => {
  const msgs = [text('user', 'hi'), text('assistant', 'hello')]
  const { toCompress, toKeep } = planCompactByTokens(msgs, 500, tokenEstimator)
  assertEq(toCompress.length, 0, '无压缩')
  assertEq(toKeep.length, 2, '全部保留')
})

test('预算极大 → 全部保留', () => {
  const msgs = makeLongHistory()
  const { toCompress, toKeep } = planCompactByTokens(msgs, 10_000_000, tokenEstimator)
  assertEq(toCompress.length, 0, '无压缩')
  assertEq(toKeep.length, msgs.length, '全部保留')
})

test('整个序列是一个并行工具组 → 放弃压缩（切点回退到 0）', () => {
  const calls = Array.from({ length: 20 }, (_, i) => tc(`c${i}`, `t${i}`))
  const msgs: ChatMessage[] = [
    assistantWithCalls(...calls),
    ...Array.from({ length: 20 }, (_, i) => toolResult(`c${i}`, `t${i}`, 'Z'.repeat(500))),
  ]
  const { toCompress, toKeep } = planCompactByTokens(msgs, 5000, tokenEstimator)
  assertEq(toCompress.length, 0, '放弃压缩')
  assertEq(toKeep.length, msgs.length, '全部保留')
})

// ============================================================
console.log('\nsanitizeHistoryWithIds')
// ============================================================

test('ids 与清洗后消息平行对齐（删除中间消息不错位）', () => {
  const msgs: ChatMessage[] = [
    text('user', 'hi'),
    toolResult('ghost', 'bash', '???'), // 孤儿 → 删除
    text('assistant', 'hello'),
    assistantWithCalls(tc('c9', 'bash')), // 悬空组 → 删除
    text('user', 'next'),
  ]
  const ids = ['m0', 'm1', 'm2', 'm3', 'm4']
  const { messages, ids: outIds } = sanitizeHistoryWithIds(msgs, ids)
  assertEq(outIds.length, messages.length, 'ids 与消息等长')
  // 保留 m0(user) m2(assistant) m4(user)，删除 m1(孤儿) m3(悬空)
  assertEq(outIds[0], 'm0', '第一条 id 对齐')
  assertEq(outIds[1], 'm2', '第二条 id 对齐（跳过被删的 m1）')
  assertEq(outIds[2], 'm4', '第三条 id 对齐（跳过被删的 m3）')
  for (let i = 0; i < messages.length; i++) {
    assert(messages[i].role === (msgs[parseInt(outIds[i]!.slice(1), 10)] as ChatMessage).role, `msg[${i}] 与 id 对应`)
  }
})

test('完整合法序列 → ids 全保留', () => {
  const msgs = makeLongHistory()
  const ids = msgs.map((_, i) => `id${i}`)
  const { messages, ids: outIds } = sanitizeHistoryWithIds(msgs, ids)
  assertEq(outIds.length, ids.length, '无删除')
  for (let i = 0; i < ids.length; i++) assertEq(outIds[i], ids[i], `ids[${i}] 不变`)
})

// ============================================================
console.log('\nbuildEffectiveConversation（压缩只影响 LLM 上下文，不动历史）')
// ============================================================

test('无压缩 → 返回完整列表，keptFromIndex=0', () => {
  const msgs = makeLongHistory()
  const ids = msgs.map((_, i) => `id${i}`)
  const r = buildEffectiveConversation(msgs, ids, null)
  assertEq(r.effective.length, msgs.length, '长度不变')
  assertEq(r.keptFromIndex, 0, 'keptFromIndex=0')
  assertEq(r.hasSummary, false, '无摘要')
})

test('有压缩 → 边界之前的消息被摘要替换，之后原样保留', () => {
  const msgs = makeLongHistory() // 13 条
  const ids = msgs.map((_, i) => `id${i}`)
  // 边界 = 第 4 条（id3），id4..id12 保留
  const compaction: CompactionState = { upToMessageId: 'id3', summary: '之前讨论了项目结构' }
  const r = buildEffectiveConversation(msgs, ids, compaction)
  assertEq(r.hasSummary, true, '有摘要')
  assertEq(r.keptFromIndex, 4, 'keptFromIndex = 边界下标+1')
  assertEq(r.effective.length, 1 + (msgs.length - 4), '摘要 + 保留段')
  assertEq(r.effective[0].role, 'user', '首条为摘要消息')
  assertEq(typeof r.effective[0].content, 'string')
  assert((r.effective[0].content as string).startsWith(COMPACT_SUMMARY_PREFIX), '摘要带前缀')
  assert((r.effective[0].content as string).includes('之前讨论了项目结构'), '摘要内容正确')
  // 保留段 = 原 id4.. 的消息（引用一致）
  for (let i = 4; i < msgs.length; i++) {
    assertEq(r.effective[i - 3], msgs[i], `effective[${i - 3}] 是原消息 ${i}`)
  }
})

test('边界不存在 → 忽略压缩，返回完整列表', () => {
  const msgs = makeLongHistory()
  const ids = msgs.map((_, i) => `id${i}`)
  const compaction: CompactionState = { upToMessageId: 'nonexistent', summary: 'x' }
  const r = buildEffectiveConversation(msgs, ids, compaction)
  assertEq(r.hasSummary, false, '无摘要')
  assertEq(r.effective.length, msgs.length, '完整返回')
})

test('边界 = 最后一条 → 只有摘要（保留段为空）', () => {
  const msgs = makeLongHistory()
  const ids = msgs.map((_, i) => `id${i}`)
  const last = ids[ids.length - 1]
  const r = buildEffectiveConversation(msgs, ids, { upToMessageId: last, summary: 'all' })
  assertEq(r.effective.length, 1, '只剩摘要')
  assertEq(r.keptFromIndex, msgs.length, 'keptFromIndex 指向末尾')
})

test('边界 = 第一条 → 摘要 + 其余全部保留', () => {
  const msgs = makeLongHistory()
  const ids = msgs.map((_, i) => `id${i}`)
  const r = buildEffectiveConversation(msgs, ids, { upToMessageId: ids[0], summary: 'first' })
  assertEq(r.hasSummary, true, '有摘要')
  assertEq(r.keptFromIndex, 1, 'keptFromIndex=1')
  assertEq(r.effective.length, 1 + (msgs.length - 1), '摘要 + 其余')
})

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
