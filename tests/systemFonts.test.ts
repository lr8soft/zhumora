import assert from 'node:assert/strict'
import {
  availableFontFamilies,
  defaultFontCandidatesForLocale,
  getSystemLocale,
  listSystemFonts,
  normalizeFontName,
  parseRegistryEntries,
  resolveDefaultFont,
  resolveSystemFont,
  stripStyleWords
} from '../src/main/tools/systemFonts.ts'

// 纯函数：注册表名解析
assert.equal(stripStyleWords('Microsoft YaHei Bold'), 'Microsoft YaHei')
assert.equal(stripStyleWords('Optima Semibold Italic'), 'Optima')
assert.equal(stripStyleWords('Times New Roman'), 'Times New Roman')

const yahei = normalizeFontName('Microsoft YaHei & Microsoft YaHei UI (TrueType)')
assert.deepEqual(yahei, { name: 'Microsoft YaHei', aliases: ['Microsoft YaHei', 'Microsoft YaHei UI'], style: '' })

const yaheiBold = normalizeFontName('Microsoft YaHei Bold & Microsoft YaHei UI Bold (TrueType)')
assert.equal(yaheiBold.name, 'Microsoft YaHei')
assert.equal(yaheiBold.style, 'bold')
assert.ok(yaheiBold.aliases.includes('Microsoft YaHei Bold'))
assert.ok(yaheiBold.aliases.includes('Microsoft YaHei UI'))

const userFont = normalizeFontName('优设标题黑 Regular (TrueType)')
assert.equal(userFont.name, '优设标题黑')
assert.deepEqual(userFont.aliases, ['优设标题黑 Regular', '优设标题黑'])

// 纯函数：reg query 输出解析（跳过键头、子键行、空行）
const registryOutput = [
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  '    Consolas (TrueType)    REG_SZ    consola.ttf',
  '    SimSun & NSimSun (TrueType)    REG_SZ    simsun.ttc',
  '    User Font (TrueType)    REG_SZ    C:\\Users\\me\\Fonts\\user.ttf',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts\\Some.App',
  '',
  'No error text'
].join('\r\n')
const entries = parseRegistryEntries(registryOutput)
assert.equal(entries.size, 3)
assert.equal(entries.get('Consolas (TrueType)'), 'consola.ttf')
assert.equal(entries.get('SimSun & NSimSun (TrueType)'), 'simsun.ttc')
assert.equal(entries.get('User Font (TrueType)'), 'C:\\Users\\me\\Fonts\\user.ttf')

// 纯函数：locale → 默认字体候选（各平台一致）
assert.equal(defaultFontCandidatesForLocale('zh-CN')[0], 'Microsoft YaHei')
assert.equal(defaultFontCandidatesForLocale('zh_CN')[0], 'Microsoft YaHei')
assert.equal(defaultFontCandidatesForLocale('zh-TW')[0], 'Microsoft JhengHei')
assert.equal(defaultFontCandidatesForLocale('ja-JP')[0], 'Yu Gothic UI')
assert.equal(defaultFontCandidatesForLocale('ko-KR')[0], 'Malgun Gothic')
assert.ok(defaultFontCandidatesForLocale('en-US')[0].length > 0)

// 实测：本机枚举 + 名称解析
if (process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin') {
  const fonts = await listSystemFonts()
  assert.ok(fonts.length > 0, 'expected at least one system font')
  assert.ok(fonts.every(f => f.file && f.name && f.aliases.length > 0))

  // 缓存命中
  assert.equal(await listSystemFonts(), fonts)

  const families = availableFontFamilies(fonts)
  assert.deepEqual(families, [...families].sort((a, b) => a.localeCompare(b)))

  // 当前语言默认字体
  const locale = await getSystemLocale()
  assert.match(locale, /^[a-z]{2}/i)
  const defaultFont = await resolveDefaultFont()
  assert.ok(defaultFont.file)
  assert.ok(defaultFont.name)

  if (process.platform === 'win32') {
    const yaheiHit = await resolveSystemFont('Microsoft YaHei')
    assert.equal(yaheiHit.style, '')
    assert.match(yaheiHit.file, /msyh\.ttc$/)
    const yaheiBoldHit = await resolveSystemFont('microsoft yahei bold')
    assert.equal(yaheiBoldHit.style, 'bold')
    assert.match(yaheiBoldHit.file, /msyhbd\.ttc$/)
  }

  await assert.rejects(() => resolveSystemFont('NoSuchFontZhumora123'), /No matching system font/)
}
