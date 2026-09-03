import type { ToolDefinition } from '../../shared/types'

export type OfficeToolName =
  | 'word_document'
  | 'excel_workbook'
  | 'powerpoint_presentation'
  | 'pdf_document'

export interface OfficeRoute {
  toolName: OfficeToolName
  format: 'docx' | 'xlsx' | 'pptx' | 'pdf'
}

const ROUTES: Array<OfficeRoute & { signal: RegExp }> = [
  { toolName: 'powerpoint_presentation', format: 'pptx', signal: /(?:\.pptx\b|\bpowerpoint\b|\bppt\b|幻灯片|演示文稿)/i },
  { toolName: 'excel_workbook', format: 'xlsx', signal: /(?:\.xlsx\b|\bexcel\b|电子表格|工作簿)/i },
  { toolName: 'word_document', format: 'docx', signal: /(?:\.docx\b|\bword\b|word\s*文档)/i },
  { toolName: 'pdf_document', format: 'pdf', signal: /(?:\.pdf\b|\bpdf\b)/i }
]

const ARTIFACT_ACTION = /(?:读取|打开|查看|提取|总结|创建|制作|生成|新建|编辑|修改|调整|更新|美化|排版|配色|颜色|样式|转换|导出|填写|填充|继续|write|read|open|inspect|extract|summari[sz]e|create|make|generate|edit|modify|adjust|update|format|style|color|convert|export|fill|continue)/i
const CODE_INTENT = /(?:\b(?:python|javascript|typescript|node(?:\.js)?|powershell|library|sdk|api)\b|脚本|代码|程序|编程|源码)/i
const NEGATED_CODE_INTENT = /(?:不要|不用|禁止|避免|别|do\s+not|don't|not|without|instead\s+of)[^,，。\n]{0,18}(?:python|javascript|typescript|node(?:\.js)?|powershell|脚本|代码)(?:\s*(?:脚本|代码|script|code))?/ig

/**
 * Detect direct Office-artifact work from the latest user turn.
 * Requests for source code or scripts are intentionally excluded: users can still
 * explicitly ask the coding agent to implement an Office-processing program.
 */
export function detectOfficeRoute(text: string, recentContext = ''): OfficeRoute | null {
  const normalized = text.replace(NEGATED_CODE_INTENT, '')
  if (CODE_INTENT.test(normalized)) return null
  if (!ARTIFACT_ACTION.test(normalized)) return null

  for (const route of ROUTES) {
    if (route.signal.test(normalized)) {
      return { toolName: route.toolName, format: route.format }
    }
  }
  for (const route of ROUTES) {
    if (route.signal.test(recentContext)) {
      return { toolName: route.toolName, format: route.format }
    }
  }
  return null
}

const OFFICE_SUPPORT_TOOLS = new Set([
  'read',
  'ls',
  'glob',
  'grep'
])

/**
 * Small models choose tools more reliably when irrelevant executors are absent.
 * In Office mode, keep discovery tools and exactly one format-specific
 * artifact tool; notably exclude bash/write/edit and unrelated MCP tools.
 */
export function selectToolsForOfficeRoute(
  tools: ToolDefinition[],
  route: OfficeRoute | null
): ToolDefinition[] {
  if (!route) return tools
  return tools.filter(tool => {
    const name = tool.function.name
    return name === route.toolName || OFFICE_SUPPORT_TOOLS.has(name)
  })
}

export function isOfficeToolName(name: string): name is OfficeToolName {
  return ROUTES.some(route => route.toolName === name)
}
