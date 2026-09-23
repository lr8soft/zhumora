// ============================================================
// Skill 管理器 — Agent Skills 规范（agentskills.io）对齐
// 一个 Skill 是一个目录（含 SKILL.md + 可选 scripts/references/assets）
// 或单个 SKILL.md 文件（兼容旧导入）。
// 渐进加载：系统提示词只注入 name + description；
// 模型调用 `skill` 工具时才加载 SKILL.md 正文（见 skillTool.ts）。
// ============================================================
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import matter from 'gray-matter'
import type { SkillConfig } from '../../shared/types.ts'
import { log } from '../llm/logger.ts'

export const SKILL_SOURCE = 'skill'

/**
 * Agent Skills 规范（agentskills.io）的 name 约束：
 * 1-64 个「unicode 小写字母、数字、连字符」，不得以连字符开头/结尾，
 * 不得出现连续连字符，且必须与目录名一致。
 * "unicode lowercase alphanumeric" = Unicode 小写字母（Ll）+ 无大小写体系的字母
 * （Lo，如 CJK/假名/谚文，它们没有大写形态）+ 十进制数字（Nd）。
 * 大小写语言中的大写字母（如 "PDF-Processing"）按规范拒绝。
 */
const SKILL_NAME_CHAR_RE = /^[\p{Ll}\p{Lo}\p{Nd}-]+$/u

function isValidSkillName(name: string): boolean {
  if (![...name].length || [...name].length > 64) return false
  if (name.startsWith('-') || name.endsWith('-')) return false
  if (name.includes('--')) return false
  return SKILL_NAME_CHAR_RE.test(name)
}

function skillNameError(name: string): string {
  return `Invalid skill name "${name}". The spec allows 1-64 unicode lowercase letters (any script, e.g. 中文, é) and digits joined by single hyphens — no leading/trailing or consecutive hyphens, no uppercase.`
}

interface BundledFile {
  relPath: string
  absPath: string
}

export interface LoadedSkill {
  config: SkillConfig
  /** 目录型 skill 的路径；文件型为所在目录 */
  root: string
  name: string
  description: string
  content: string
  files: BundledFile[]
}

export interface SkillInspection {
  valid: boolean
  kind: 'folder' | 'file'
  name: string
  description: string
  error?: string
  /** 非致命提示（如 name 与目录名不一致）：skill 仍加载，name 以 frontmatter 为准 */
  warning?: string
}

let loadedSkills: LoadedSkill[] = []

const BUNDLED_DIRS = ['scripts', 'references', 'assets']
const MAX_BUNDLED_FILES = 200
const MAX_FILES_DEPTH = 3
const SKIP_DIRS = new Set(['node_modules', '.git'])

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function collectBundledFiles(root: string, includeTopLevel: boolean): Promise<BundledFile[]> {
  const out: BundledFile[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_BUNDLED_FILES || depth > MAX_FILES_DEPTH) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (out.length >= MAX_BUNDLED_FILES) return
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs, depth + 1)
      } else if (entry.isFile()) {
        out.push({ relPath: path.relative(root, abs).split(path.sep).join('/'), absPath: abs })
      }
    }
  }
  for (const name of BUNDLED_DIRS) {
    if (out.length >= MAX_BUNDLED_FILES) break
    const dir = path.join(root, name)
    if (await isDirectory(dir)) await walk(dir, 1)
  }
  // 规范允许 skill 根目录直接放任意文件（SKILL.md 正文常引用同目录参考文件）。
  // 仅目录型 skill 启用：单文件导入的 root 只是所在目录，枚举其兄弟文件是噪音。
  if (!includeTopLevel) return out
  try {
    const topEntries = await fs.readdir(root, { withFileTypes: true })
    for (const entry of topEntries) {
      if (out.length >= MAX_BUNDLED_FILES) break
      if (!entry.isFile() || entry.name.startsWith('.') || entry.name.toUpperCase() === 'SKILL.MD') continue
      const abs = path.join(root, entry.name)
      out.push({ relPath: entry.name, absPath: abs })
    }
  } catch {
    // root 不可读时仅失去根级文件清单，不阻塞 skill 加载
  }
  return out
}

function parseSkillMd(raw: string): { name: string; description: string; content: string } {
  const { data, content } = matter(raw)
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  return { name, description, content: content.trim() }
}

/**
 * 校验路径是否是一个合法 Skill（目录含 SKILL.md，或单个 .md 文件）。
 * 供设置页在添加前检查；不通过的路径不得入库。
 */
export async function inspectSkillPath(p: string): Promise<SkillInspection> {
  const base = path.basename(p).replace(/\.md$/i, '')
  if (await isDirectory(p)) {
    const skillMd = path.join(p, 'SKILL.md')
    let raw: string
    try {
      raw = await fs.readFile(skillMd, 'utf-8')
    } catch {
      return { valid: false, kind: 'folder', name: base, description: '', error: 'Directory must contain a SKILL.md file.' }
    }
    const parsed = parseSkillMd(raw)
    if (!parsed.name) return { valid: false, kind: 'folder', name: base, description: parsed.description, error: 'SKILL.md frontmatter is missing the required "name" field.' }
    if (!isValidSkillName(parsed.name)) return { valid: false, kind: 'folder', name: base, description: parsed.description, error: skillNameError(parsed.name) }
    if (!parsed.description) return { valid: false, kind: 'folder', name: parsed.name, description: '', error: 'SKILL.md frontmatter is missing the required "description" field.' }
    if (parsed.description.length > 1024) return { valid: false, kind: 'folder', name: parsed.name, description: parsed.description, error: `description must be at most 1024 characters (currently ${parsed.description.length}).` }
    if (!parsed.content) return { valid: false, kind: 'folder', name: parsed.name, description: parsed.description, error: 'SKILL.md has no instruction content after the frontmatter.' }
    // 目录名与 frontmatter name 不一致只降级为警告：Zhumora 由用户显式选路径加载，
    // frontmatter name 是权威 ID（目录遍历型客户端才需要目录名匹配）。
    const warning = parsed.name !== base
      ? `Skill name "${parsed.name}" differs from its folder name "${base}". Loaded using the frontmatter name.`
      : undefined
    return { valid: true, kind: 'folder', name: parsed.name, description: parsed.description, warning }
  }
  // 单文件模式（兼容旧导入）：.md 文件名即 skill name
  if (!(p.toLowerCase().endsWith('.md'))) {
    return { valid: false, kind: 'file', name: base, description: '', error: 'Select a .md skill file or a folder containing SKILL.md.' }
  }
  let raw: string
  try {
    raw = await fs.readFile(p, 'utf-8')
  } catch {
    return { valid: false, kind: 'file', name: base, description: '', error: 'File could not be read.' }
  }
  const parsed = parseSkillMd(raw)
  const name = parsed.name || base
  if (!isValidSkillName(name)) return { valid: false, kind: 'file', name, description: parsed.description, error: skillNameError(name) }
  if (!parsed.description) return { valid: false, kind: 'file', name, description: '', error: 'Frontmatter is missing the required "description" field.' }
  if (parsed.description.length > 1024) return { valid: false, kind: 'file', name, description: parsed.description, error: `description must be at most 1024 characters (currently ${parsed.description.length}).` }
  if (!parsed.content) return { valid: false, kind: 'file', name, description: parsed.description, error: 'File has no instruction content after the frontmatter.' }
  return { valid: true, kind: 'file', name, description: parsed.description }
}

/**
 * 从配置加载一个 Skill。目录型指向含 SKILL.md 的目录；文件型指向单个 .md。
 */
export async function loadSkill(config: SkillConfig): Promise<LoadedSkill | null> {
  if (!config.enabled) return null
  const inspection = await inspectSkillPath(config.path)
  if (!inspection.valid) {
    log('error', `Failed to load skill "${config.name}": ${inspection.error}`)
    return null
  }
  let raw: string
  const root = inspection.kind === 'folder' ? config.path : path.dirname(config.path)
  try {
    raw = inspection.kind === 'folder'
      ? await fs.readFile(path.join(config.path, 'SKILL.md'), 'utf-8')
      : await fs.readFile(config.path, 'utf-8')
  } catch (err) {
    log('error', `Failed to load skill "${config.name}": ${(err as Error).message}`)
    return null
  }
  const parsed = parseSkillMd(raw)
  const files = await collectBundledFiles(root, inspection.kind === 'folder')
  log('info', `Skill "${inspection.name}" loaded from ${config.path}${files.length > 0 ? ` (+${files.length} bundled file(s))` : ''}`)
  return {
    config,
    root,
    name: inspection.name,
    description: inspection.description,
    content: parsed.content,
    files
  }
}

/**
 * 重新加载所有 Skill。同名 skill 只保留第一个（后者忽略并记日志）。
 */
export async function reloadSkills(configs: SkillConfig[]): Promise<void> {
  const next: LoadedSkill[] = []
  const seen = new Set<string>()
  for (const config of configs) {
    const skill = await loadSkill(config)
    if (!skill) continue
    if (seen.has(skill.name)) {
      log('warn', `Skill "${skill.name}" skipped: duplicate name (kept the first one)`)
      continue
    }
    seen.add(skill.name)
    next.push(skill)
  }
  loadedSkills = next
  log('info', `Skills reloaded: ${loadedSkills.length} active`)
}

/**
 * 系统提示词注入段：只含 name + description 清单（Agent Skills 渐进加载第一层）。
 * 正文与捆绑文件由 `skill` 工具按需返回。
 */
export function getSkillsSystemPrompt(): string {
  if (loadedSkills.length === 0) return ''

  let prompt = '\n\n## Available Skills'
  prompt += 'The following skills provide specialized instructions for specific tasks. '
  prompt += 'Full instructions are NOT shown here; when a task matches a skill, call the `skill` tool with the skill name to load them before acting.\n\n'
  for (const skill of loadedSkills) {
    prompt += `- ${skill.name}: ${skill.description}\n`
  }
  return prompt
}

export interface SkillContent {
  name: string
  description: string
  content: string
  root: string
  files: BundledFile[]
}

/**
 * 按需加载一个 Skill 的完整内容（渐进加载第二层）。
 * 返回正文 + skill 根路径 + 捆绑文件清单，agent 用文件工具读取所需文件。
 */
export function getSkillContent(name: string): SkillContent | null {
  const skill = loadedSkills.find(s => s.name === name)
  if (!skill) return null
  return {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    root: skill.root,
    files: skill.files
  }
}

/** 获取已加载的 Skill 简略列表 */
export function getLoadedSkillsInfo(): { name: string; description: string; kind: 'folder' | 'file' }[] {
  return loadedSkills.map(s => ({
    name: s.name,
    description: s.description,
    kind: s.config.path.toLowerCase().endsWith('.md') ? 'file' : 'folder'
  }))
}
