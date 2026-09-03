// 系统字体读取器：枚举本机已安装的字体（zhumora 不打包任何字体），
// 供办公类工具（如 pdf-lib 写中文 PDF）按需读取字体文件并嵌入。
//
// 各平台策略：
// - win32: 读字体注册表（HKLM 系统字体 + HKCU 用户字体），注册表即"已注册字体"的
//   权威数据源。reg query 默认按 GBK 输出，先 chcp 65001 强制 UTF-8。
// - linux: fc-list（fontconfig，主流发行版标配）。
// - darwin: 扫描三个标准字体目录（/System、/Library、~/Library）。
//
// 纯 JS 无原生依赖；结果内存缓存，listSystemFonts(true) 可强制刷新。
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface SystemFont {
  /** 主显示名（如 "Microsoft YaHei"） */
  name: string
  /** 全部注册别名，含 name（如 ["Microsoft YaHei", "Microsoft YaHei UI"]） */
  aliases: string[]
  /** 从名称解析出的风格提示（bold/light/medium/italic…），空字符串表示 regular */
  style: string
  /** 字体文件绝对路径（ttf/otf/ttc/otc） */
  file: string
}

const FONT_EXTS = new Set(['.ttf', '.otf', '.ttc', '.otc'])

const STYLE_WORDS: Array<[string, RegExp]> = [
  ['bold', /\bbold\b/i],
  ['semibold', /\bsemi\s?bold\b/i],
  ['medium', /\bmedium\b/i],
  ['light', /\blight\b/i],
  ['thin', /\bthin\b|\bhairline\b/i],
  ['black', /\bblack\b/i],
  ['italic', /\bitalic\b|\boblique\b/i]
]

function detectStyle(text: string): string {
  for (const [style, pattern] of STYLE_WORDS) {
    if (pattern.test(text)) return style
  }
  return ''
}

/** 去掉风格词（"Microsoft YaHei Bold" → "Microsoft YaHei"） */
export function stripStyleWords(text: string): string {
  const stripped = text
    .replace(/\b(bold italic|bold|semibold|semi-bold|medium|light|thin|hairline|black|heavy|regular|italic|oblique)\b/gi, ' ')
    .replace(/[\s\-_]+/g, ' ')
    .trim()
  return stripped
}

/**
 * 去掉注册表名末尾的 "(TrueType)"/"(OpenType)" 类型后缀，拆出别名，识别风格。
 * 返回的族名已剥离风格词；aliases 同时包含原始名和剥离名，保证
 * 查 "YaHei Bold" 和查 "YaHei" 都能命中对应条目。
 */
export function normalizeFontName(raw: string): { name: string; aliases: string[]; style: string } {
  const base = raw.replace(/\s*\((?:TrueType|OpenType|Type ?1|PostScript)\)\s*$/i, '').trim()
  const rawAliases = base.split('&').map(a => a.trim()).filter(Boolean)
  const source = rawAliases.length ? rawAliases : [base]
  const style = detectStyle(source.join(' '))
  const aliases = [...source]
  for (const alias of source) {
    const stripped = stripStyleWords(alias)
    if (stripped && !aliases.includes(stripped)) aliases.push(stripped)
  }
  const name = stripStyleWords(source[0]) || source[0]
  return { name, aliases, style }
}

/** 解析 reg query 输出，返回 名称 → 文件 的映射（跳过键头和空行） */
export function parseRegistryEntries(output: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s{4,}(.+?)\s{2,}REG_SZ\s{2,}(.+?)\s*$/)
    if (match) entries.set(match[1], match[2])
  }
  return entries
}

function runShell(command: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
    const child = spawn(command, { shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      child.kill()
      reject(new Error(`font lookup timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.stdout.on('data', d => chunks.push(d))
    child.stderr.on('data', d => chunks.push(d))
    child.once('error', error => {
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`font lookup failed (exit ${code})`))
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

async function queryFontRegistry(hive: 'HKLM' | 'HKCU'): Promise<Map<string, string>> {
  const output = await runShell(`chcp 65001 >nul & reg query "${hive}\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"`)
  return parseRegistryEntries(output)
}

async function queryFontsDir(): Promise<string> {
  try {
    const output = await runShell(`chcp 65001 >nul & reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v FontsDir`)
    const match = output.match(/\bFontsDir\s+REG_SZ\s+(.+?)\s*$/)
    if (match) return match[1].trim()
  } catch { /* 用默认目录 */ }
  return path.join('C:\\', 'Windows', 'Fonts')
}

async function listWindowsFonts(): Promise<SystemFont[]> {
  const [systemEntries, userEntries, fontsDir] = await Promise.all([
    queryFontRegistry('HKLM'),
    queryFontRegistry('HKCU').catch(() => new Map<string, string>()),
    queryFontsDir()
  ])
  const fonts: SystemFont[] = []
  const seen = new Set<string>()
  for (const [rawName, rawFile] of [...systemEntries, ...userEntries]) {
    const file = path.isAbsolute(rawFile) ? rawFile : path.join(fontsDir, rawFile)
    if (!FONT_EXTS.has(path.extname(file).toLowerCase())) continue
    const key = `${rawName}\u0000${file}`
    if (seen.has(key)) continue
    seen.add(key)
    const { name, aliases, style } = normalizeFontName(rawName)
    fonts.push({ name, aliases, style, file })
  }
  return fonts
}

async function listLinuxFonts(): Promise<SystemFont[]> {
  const output = await runShell('fc-list : family file', 30_000)
  const fonts: SystemFont[] = []
  const seen = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const sep = line.lastIndexOf(':')
    if (sep < 0) continue
    const file = line.slice(0, sep).trim()
    if (!FONT_EXTS.has(path.extname(file).toLowerCase())) continue
    let familyPart = line.slice(sep + 1).trim()
    let stylePart = ''
    const eq = familyPart.indexOf(':style=')
    if (eq >= 0) {
      familyPart = familyPart.slice(0, eq)
      stylePart = familyPart.slice(eq + 7)
    }
    const families = familyPart.split(',').map(f => f.trim()).filter(Boolean)
    if (!families.length) continue
    const key = `${families[0]}\u0000${file}`
    if (seen.has(key)) continue
    seen.add(key)
    fonts.push({
      name: families[0],
      aliases: families,
      style: detectStyle(`${families[0]} ${stylePart}`),
      file
    })
  }
  return fonts
}

const MAC_FONT_DIRS = ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts']
const MAC_STYLE_SUFFIX = /^(.*)[- ](Regular|Bold|Semibold|Light|Thin|Medium|Black|Italic|Bold Italic)$/i

async function listMacFonts(): Promise<SystemFont[]> {
  const fonts: SystemFont[] = []
  const dirs = [...MAC_FONT_DIRS, path.join(os.homedir(), 'Library', 'Fonts')]
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase()
      if (!FONT_EXTS.has(ext)) continue
      const file = path.join(dir, entry)
      const stem = path.basename(entry, ext)
      const suffix = stem.match(MAC_STYLE_SUFFIX)
      const name = (suffix ? suffix[1] : stem).trim()
      const style = suffix ? (detectStyle(suffix[2]) || suffix[2].toLowerCase()) : detectStyle(stem)
      fonts.push({ name: name || stem, aliases: [name || stem, stem], style, file })
    }
  }
  return fonts
}

let cache: SystemFont[] | null = null

/**
 * 各语言在 Windows 上的默认 UI 字体（与系统字体回退链 FontLink 的顺序一致），
 * 后接各平台的兜底字体。按 locale 语言匹配，第一个命中的候选优先。
 */
const CJK_FONT_CANDIDATES: Array<{ match: RegExp; families: string[] }> = [
  { match: /^zh[-_]?(TW|HK|Hant)/i, families: ['Microsoft JhengHei', 'PingFang TC', 'Noto Sans CJK TC'] },
  { match: /^zh/i, families: ['Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC'] },
  { match: /^ja/i, families: ['Yu Gothic UI', 'Hiragino Sans', 'Noto Sans CJK JP'] },
  { match: /^ko/i, families: ['Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans CJK KR'] }
]

const PLATFORM_FALLBACK_FONTS: Record<string, string[]> = {
  win32: ['Segoe UI'],
  darwin: ['Helvetica Neue', 'Arial'],
  linux: ['Noto Sans', 'DejaVu Sans']
}

/** 按 locale（如 "zh-CN"/"ja-JP"）返回默认字体候选族名列表（含平台兜底） */
export function defaultFontCandidatesForLocale(locale: string): string[] {
  const entry = CJK_FONT_CANDIDATES.find(c => c.match.test(locale))
  const platform = PLATFORM_FALLBACK_FONTS[process.platform] || []
  return entry ? [...entry.families, ...platform] : [...platform]
}

let localeCache: string | null = null

/**
 * 系统当前语言的 locale（如 "zh-CN"、"ja-JP"）：
 * - win32: 注册表 HKCU\Control Panel\International 的 LocaleName
 * - darwin: defaults read -g AppleLocale
 * - linux: LANG / LC_ALL 环境变量
 * 都取不到时回退 Intl（跟随进程 locale）。结果缓存。
 */
export async function getSystemLocale(): Promise<string> {
  if (localeCache) return localeCache
  let locale = ''
  try {
    if (process.platform === 'win32') {
      const output = await runShell('chcp 65001 >nul & reg query "HKCU\\Control Panel\\International" /v LocaleName')
      locale = output.match(/LocaleName\s+REG_SZ\s+(.+?)\s*$/)?.[1].trim() || ''
    } else if (process.platform === 'darwin') {
      locale = (await runShell('defaults read -g AppleLocale 2>/dev/null')).trim()
    } else {
      locale = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').split('.')[0]
    }
  } catch { /* 回退 Intl */ }
  if (!locale || /^C$|^POSIX$/.test(locale)) locale = Intl.DateTimeFormat().resolvedOptions().locale
  localeCache = locale
  return locale
}

/**
 * 当前语言对应的默认字体（不指定字体时的正确默认值）：
 * 按系统 locale 选语言默认族（zh-CN→微软雅黑、ja→Yu Gothic…），
 * 逐个候选尝试，未安装则落到平台兜底字体。
 */
export async function resolveDefaultFont(style = ''): Promise<SystemFont> {
  const locale = await getSystemLocale()
  const wanted = detectStyle(style)
  let lastError: Error | null = null
  for (const family of defaultFontCandidatesForLocale(locale)) {
    try {
      return await resolveSystemFont(wanted ? `${family} ${wanted}` : family)
    } catch (error) {
      lastError = error as Error
    }
  }
  throw lastError || new Error(`No default font available for locale ${locale}`)
}

/** 枚举本机全部已注册字体；结果缓存，refresh=true 强制重新枚举 */
export async function listSystemFonts(refresh = false): Promise<SystemFont[]> {
  if (cache !== null && !refresh) return cache
  const platform = process.platform
  let fonts: SystemFont[]
  if (platform === 'win32') fonts = await listWindowsFonts()
  else if (platform === 'linux') fonts = await listLinuxFonts()
  else if (platform === 'darwin') fonts = await listMacFonts()
  else throw new Error(`Unsupported platform for font lookup: ${platform}`)
  cache = fonts
  return fonts
}

export function availableFontFamilies(fonts: SystemFont[]): string[] {
  const set = new Set<string>()
  for (const font of fonts) set.add(font.name)
  return [...set].sort((a, b) => a.localeCompare(b))
}

function normalizeQuery(text: string): string {
  return text.toLowerCase().replace(/[\s_\-\u00a0]+/g, ' ').trim()
}

/**
 * 按名称解析系统字体：精确匹配（含别名）→ 前缀匹配 → 子串匹配。
 * 同名多风格（regular/bold…）时，查询带风格词则取对应风格，否则优先 regular。
 */
export async function resolveSystemFont(query: string): Promise<SystemFont> {
  const fonts = await listSystemFonts()
  const q = normalizeQuery(query)
  if (!q) throw new Error('A font name is required')

  const matches = (font: SystemFont, mode: 'exact' | 'prefix' | 'contains'): boolean => {
    const names = font.aliases.map(normalizeQuery)
    if (mode === 'exact') return names.includes(q)
    if (mode === 'prefix') return names.some(n => n.startsWith(q))
    return names.some(n => n.includes(q))
  }

  let pool = fonts.filter(f => matches(f, 'exact'))
  if (!pool.length) pool = fonts.filter(f => matches(f, 'prefix'))
  if (!pool.length) pool = fonts.filter(f => matches(f, 'contains'))
  if (!pool.length) {
    const families = availableFontFamilies(fonts)
    throw new Error(
      `No matching system font for "${query}". Available families (${families.length}): ` +
      families.slice(0, 60).join(', ') + (families.length > 60 ? '…' : '')
    )
  }

  if (pool.length > 1) {
    const wanted = detectStyle(query)
    const preferred = pool.find(f => (wanted ? f.style === wanted : f.style === ''))
    if (preferred) return preferred
  }
  return pool[0]
}
