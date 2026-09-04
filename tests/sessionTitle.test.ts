// ============================================================
// 会话标题兜底测试 — 默认标题判断 / LLM 结果清洗 / 生成流程
// ============================================================
import assert from 'node:assert/strict'
import {
  DEFAULT_SESSION_TITLE,
  SESSION_TITLE_REMINDER,
  sessionNeedsTitle,
  sanitizeSessionTitle
} from '../src/shared/sessionTitle.ts'
import { ensureSessionTitle, collectUserTexts } from '../src/main/agent/titleService.ts'
import type { ProviderConfig } from '../src/shared/types'

// ---- sessionNeedsTitle ----
assert.equal(sessionNeedsTitle('New Session'), true)
assert.equal(sessionNeedsTitle('  New Session  '), true)
assert.equal(sessionNeedsTitle(''), true)
assert.equal(sessionNeedsTitle(null), true)
assert.equal(sessionNeedsTitle(undefined), true)
assert.equal(sessionNeedsTitle('修复登录 Bug'), false)
assert.equal(DEFAULT_SESSION_TITLE, 'New Session')
assert.match(SESSION_TITLE_REMINDER, /set_title/)
assert.match(SESSION_TITLE_REMINDER, /default title/)
assert.match(SESSION_TITLE_REMINDER, /REQUIRED/)
assert.match(SESSION_TITLE_REMINDER, /SAME batch/)

// ---- sanitizeSessionTitle ----
assert.equal(sanitizeSessionTitle('Fix Login Bug'), 'Fix Login Bug')
assert.equal(sanitizeSessionTitle('"Fix Login Bug"'), 'Fix Login Bug')
assert.equal(sanitizeSessionTitle('Title: "Fix Login Bug".'), 'Title: "Fix Login Bug')
assert.equal(sanitizeSessionTitle('\n  Fix Login Bug  \n'), 'Fix Login Bug')
assert.equal(sanitizeSessionTitle('Fix\nthe login bug'), 'Fix')
assert.equal(sanitizeSessionTitle('修复 登录 页面 的 崩溃 Bug'), '修复 登录 页面 的 崩溃 Bug')
assert.equal(sanitizeSessionTitle('一 二 三 四 五 六 七'), '一 二 三 四 五 六')
assert.equal(sanitizeSessionTitle('   '), '')
assert.equal(sanitizeSessionTitle('""'), '')
{
  const long = sanitizeSessionTitle('a'.repeat(200))
  assert.ok(Array.from(long).length <= 50)
  assert.ok(long.endsWith('…'))
}
{
  const cjk = sanitizeSessionTitle('标'.repeat(100))
  assert.ok(Array.from(cjk).length <= 50)
}

// ---- collectUserTexts ----
{
  const texts = collectUserTexts([
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '回复' },
    { role: 'tool', content: '结果' },
    { role: 'user', content: [{ type: 'text', text: '多模态' }, { type: 'image_url', image_url: { url: 'data:,' } }] }
  ])
  assert.deepEqual(texts, ['第一条', '多模态'])
}

// ---- ensureSessionTitle ----
const provider = { name: 'test', baseUrl: 'http://x', apiKey: '', defaultModel: 'm' } as ProviderConfig

// 默认标题 → 生成并应用
{
  let stored: string | null = 'New Session'
  const applied: string[] = []
  await ensureSessionTitle({
    provider,
    sessionId: 's1',
    userTexts: ['帮我修复登录页面的崩溃问题'],
    completeFn: async () => '修复登录崩溃\n',
    store: {
      getSessionTitle: () => stored,
      applyGeneratedTitle: (_id, title) => { applied.push(title); stored = title }
    }
  })
  assert.deepEqual(applied, ['修复登录崩溃'])
}

// 已有标题 → 不覆盖、不调用 LLM
{
  let completed = false
  await ensureSessionTitle({
    provider,
    sessionId: 's1',
    userTexts: ['hello'],
    completeFn: async () => { completed = true; return 'whatever' },
    store: { getSessionTitle: () => '已有标题', applyGeneratedTitle: () => assert.fail('不应写入') }
  })
  assert.equal(completed, false)
}

// 会话不存在 → 静默
{
  let completed = false
  await ensureSessionTitle({
    provider,
    sessionId: 'gone',
    userTexts: ['hello'],
    completeFn: async () => { completed = true; return 'x' },
    store: { getSessionTitle: () => null, applyGeneratedTitle: () => assert.fail('不应写入') }
  })
  assert.equal(completed, false)
}

// LLM 失败 → 静默不抛出
{
  await ensureSessionTitle({
    provider,
    sessionId: 's1',
    userTexts: ['hello'],
    completeFn: async () => { throw new Error('network down') },
    store: { getSessionTitle: () => 'New Session', applyGeneratedTitle: () => assert.fail('不应写入') }
  })
}

// LLM 返回垃圾（清洗后为空）→ 不写入
{
  await ensureSessionTitle({
    provider,
    sessionId: 's1',
    userTexts: ['hello'],
    completeFn: async () => '  ',
    store: { getSessionTitle: () => 'New Session', applyGeneratedTitle: () => assert.fail('不应写入') }
  })
}

// 无用户消息 → 不调 LLM
{
  let completed = false
  await ensureSessionTitle({
    provider,
    sessionId: 's1',
    userTexts: ['   '],
    completeFn: async () => { completed = true; return 'x' },
    store: { getSessionTitle: () => 'New Session', applyGeneratedTitle: () => assert.fail('不应写入') }
  })
  assert.equal(completed, false)
}

console.log('session title tests passed')
