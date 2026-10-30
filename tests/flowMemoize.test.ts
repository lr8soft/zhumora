// ============================================================
// flow/memoize 单元测试 — 直接 node 运行
//   node --experimental-strip-types tests/flowMemoize.test.ts
// 覆盖消息数组摘要 + 单槽缓存：
//   - 摘要覆盖投影会渲染的字段（条数 / id / toolCalls / 状态 / 文本长度），
//     任何可见变化都必须失效（缓存的投影会捕获消息对象引用）
//   - memoize 命中返回同一引用，单槽只存最近一次
//   - hashStrings 顺序敏感且与拼接歧义无关
// ============================================================
import assert from 'node:assert/strict'
import { messageDigest, hashStrings, memoize } from '../src/renderer/src/flow/memoize.ts'

type Msg = { id: string; sessionId: string; content?: string; status?: string; toolCalls?: readonly unknown[] | null; generation?: { status?: string; assessmentRevision?: number } | null }
const msg = (over: Partial<Msg> & { id: string }): Msg => ({ content: 'x', sessionId: 's', ...over })

// ---- messageDigest ----
{
  const messages = [msg({ id: 'u1' }), msg({ id: 'a1', toolCalls: [{ id: 'c1' }] })]
  const digest = messageDigest(messages)
  assert.equal(messageDigest(messages), digest, 'same array repeats the same digest')
  assert.equal(messageDigest([...messages]), digest, 'a rewrapped array of identical identities repeats')

  // 缓存的投影会捕获消息对象引用，所以流式内容增长必须让摘要变化（重算取到最新对象）
  const streamed = [messages[0], { ...messages[1], content: 'much longer streamed content' }]
  assert.notEqual(messageDigest(streamed), digest, 'streamed content growth invalidates the digest')
  const sameSizeRewrite = [messages[0], { ...messages[1], content: 'y' }]
  assert.notEqual(messageDigest(sameSizeRewrite), digest, 'same-length different-text rewrite invalidates')
  assert.equal(messageDigest([{ ...messages[0], status: undefined, content: 'x' }, messages[1]]), digest,
    'undefined status is the stable identity')
  const statused = [msg({ id: 'u1', status: 'done' }), messages[1]]
  assert.notEqual(messageDigest(statused), digest, 'status change invalidates')
  const assessed = [messages[0], { ...messages[1], generation: { status: 'complete', assessmentRevision: 2 } }]
  assert.equal(messageDigest(assessed), messageDigest(assessed))
  assert.notEqual(messageDigest(assessed), messageDigest([messages[0], { ...messages[1], generation: { status: 'complete', assessmentRevision: 3 } }]),
    'generation assessment revision invalidates')

  // push 新消息 → 变
  assert.notEqual(messageDigest([...streamed, msg({ id: 't1' })]), digest, 'appended message changes the digest')

  // 给已有消息挂新 toolCall → 变
  const withExtraCall = [messages[0], { ...messages[1], toolCalls: [{ id: 'c1' }, { id: 'c2' }] }]
  assert.notEqual(messageDigest(withExtraCall), digest, 'a new toolCall on an existing message changes the digest')

  // 删除消息 → 变
  assert.notEqual(messageDigest([messages[1]]), digest, 'removed message changes the digest')

  // toolCalls null 与缺省等价
  assert.equal(messageDigest([msg({ id: 'u1', toolCalls: null })]), messageDigest([msg({ id: 'u1' })]))

  // 同 id 同内容但不同会话 → 变（跨会话合成消息不互踩缓存）
  assert.notEqual(messageDigest([msg({ id: 'u1', sessionId: 'other' })]), messageDigest([msg({ id: 'u1' })]),
    'session identity is part of the digest')
}

// ---- hashStrings ----
{
  assert.equal(hashStrings(['a', 'b']), hashStrings(['a', 'b']))
  assert.notEqual(hashStrings(['a', 'b']), hashStrings(['b', 'a']), 'order sensitive')
  assert.notEqual(hashStrings(['ab']), hashStrings(['a', 'b']), 'no concatenation ambiguity')
  assert.notEqual(hashStrings([]), hashStrings(['']), 'empty differs from a single empty string')
  assert.match(hashStrings(['x']), /^[0-9a-z]+$/, 'base36 output')
}

// ---- memoize ----
{
  let calls = 0
  const compute = () => ({ n: ++calls })
  const first = memoize('proj', 'k1', compute)
  assert.equal(calls, 1)
  assert.equal(memoize('proj', 'k1', compute), first, 'same key returns the cached reference')
  assert.equal(calls, 1, 'cache hit does not recompute')

  // 不同 key 交替调用各自重算（单槽 → 切回 k1 也要重算）
  const second = memoize('proj', 'k2', compute)
  assert.equal(calls, 2)
  assert.notEqual(second, first)
  const back = memoize('proj', 'k1', compute)
  assert.equal(calls, 3, 'single slot keeps only the latest entry')
  assert.notEqual(back, first, 'recomputing yields a fresh object')
  assert.equal(memoize('proj', 'k1', compute), back, 'the newest entry is now the cached one')

  // 不同 name 互不干扰：各自独立命中自己的槽
  const other = memoize('other', 'k1', compute)
  assert.equal(calls, 4, 'a distinct name computes independently')
  assert.notEqual(other, back)
  assert.equal(memoize('other', 'k1', compute), other, 'each name caches its own latest entry')
  assert.equal(memoize('proj', 'k1', compute), back, 'proj keeps its own slot value')
  assert.equal(calls, 4)
}

console.log('flowMemoize tests passed')
