// ============================================================
// Skill 工具 — 模型按需加载 Skill 全文（Agent Skills 渐进加载第二层）
// 系统提示词只注入 name+description 清单；
// 模型判断任务匹配某 skill 后调用本工具获取完整指令与捆绑文件清单。
// ============================================================
import type { ToolHandler } from '../tools/registry.ts'
import { toolRegistry } from '../tools/registry.ts'
import { SKILL_SOURCE, getLoadedSkillsInfo, getSkillContent } from './manager.ts'

const MAX_SKILL_CONTENT_CHARS = 100_000
const MAX_LISTED_FILES = 50

function formatSkillContent(name: string): string {
  const skill = getSkillContent(name)
  if (!skill) {
    const available = getLoadedSkillsInfo()
    const list = available.length > 0
      ? available.map(s => `- ${s.name}: ${s.description}`).join('\n')
      : '(no skills are currently enabled)'
    return `Error: unknown skill "${name}". Available skills:\n${list}`
  }

  let content = skill.content
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    content = content.slice(0, MAX_SKILL_CONTENT_CHARS) + '\n\n[Skill content truncated. The full file is on disk — read it with your file tools if needed.]'
  }

  const header = [
    `# Skill: ${skill.name}`,
    skill.description ? `> ${skill.description}` : '',
    '',
    content,
    ''
  ].join('\n')

  if (skill.files.length === 0) {
    return header + '\nThis skill has no bundled files.'
  }

  const listed = skill.files.slice(0, MAX_LISTED_FILES)
    .map(f => `- ${f.relPath}  →  ${f.absPath}`)
    .join('\n')
  const omitted = skill.files.length - listed.length
  const fileList = [
    '',
    `## Bundled files (under ${skill.root})`,
    'Read or run these with your file/shell tools only when the instructions require them:',
    listed,
    omitted > 0 ? `…and ${omitted} more file(s) under ${skill.root}` : ''
  ].filter(l => l !== '').join('\n')

  return header + fileList
}

export const skillTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'skill',
      description: 'Load the full instructions of an enabled skill by name. Call this before acting on a task that matches an available skill (listed in the "Available Skills" section of the system prompt). Returns the skill\'s SKILL.md content plus a manifest of bundled files (root-level files, scripts/references/assets) with absolute paths.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact skill name from the Available Skills list.' }
        },
        required: ['name']
      }
    }
  },
  permission: 'safe',
  async execute(args) {
    const name = String(args.name ?? '').trim()
    if (!name) return { content: 'Error: skill name is required', isError: true }
    return { content: formatSkillContent(name) }
  }
}

/** 刷新 `skill` 工具注册（settings 变更后调用；无启用 skill 时卸载） */
export function refreshSkillTool(): void {
  toolRegistry.clear(SKILL_SOURCE)
  if (getLoadedSkillsInfo().length > 0) {
    toolRegistry.register('skill', skillTool, SKILL_SOURCE)
  }
}
