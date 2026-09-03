// 办公文件工具（docx/xlsx/pptx/pdf 读写）的 ToolHandler 定义。
// 实现逻辑在 office.ts；此处只负责 schema、描述（提示词）与权限。
import type { ToolHandler, ToolContext } from './registry.ts'
import { executeOffice, type OfficeArgs } from './office.ts'

/** read 是只读（safe）；create/edit 有副作用（normal） */
function getOfficePermission(args: Record<string, unknown>): 'safe' | 'normal' {
  return args.action === 'read' ? 'safe' : 'normal'
}

const description = [
  'Read and write office documents: Word (.docx), Excel (.xlsx), PowerPoint (.pptx), and PDF (.pdf).',
  'action=read — extract text/tables as Markdown (xlsx as CSV). PDF returns per-page text. Use this to inspect any office file; the `read` tool cannot parse these binary formats.',
  'action=create — write a NEW file from `content` (overwrites if it exists):',
  '  - docx: content is a Markdown subset (#/## headings, paragraphs, - bullets, 1. numbered lists, **bold**/*italic*, | tables |).',
  '  - xlsx: content is CSV. Multiple sheets: separate them with a line "# Sheet: Name". Numbers/booleans are auto-typed.',
  '  - pptx: content is a JSON array of slides: [{"title","bullets":[],"table":{"header":[],"rows":[[...]]},"notes"}].',
  '  - pdf: content is plain text (one line per row, auto-paginated). CJK text uses the system default font; pass `font` to pick another installed font family.',
  'action=edit — in-place, only xlsx and pdf:',
  '  - xlsx: `ops` = [{sheet?, cell, value?}, {sheet?, cell, formula?}, {sheet?, addSheet:true}, {sheet?, deleteSheet:true}]. Preserves existing formatting; formulas are NOT recalculated.',
  '  - pdf: `edit` = {fields:[{name,value}] (form fields, Latin only), texts:[{text,x,y,size,page}] (draw text with system font)}.',
  'docx/pptx cannot be edited in place — read them, then create a new file with the updated content.',
  'file_path is absolute or relative to the workspace. Read a file before editing it.'
].join('\n')

export const officeTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'office',
      description,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'create', 'edit'], description: 'read (extract text), create (new file), edit (in-place, xlsx/pdf only)' },
          file_path: { type: 'string', description: 'Absolute path, or path relative to the workspace root. Extension selects the format (.docx/.xlsx/.pptx/.pdf).' },
          content: {
            type: 'string',
            description:
              'Required for create. docx = Markdown; xlsx = CSV (# Sheet: Name for multiple sheets); pptx = JSON array of slides; pdf = plain text lines.'
          },
          ops: {
            type: 'array',
            description: 'For edit + xlsx only. Cell operations: [{sheet, cell, value}, {sheet, cell, formula}, {sheet, addSheet}, {sheet, deleteSheet}].',
            items: { type: 'object' }
          },
          edit: {
            type: 'object',
            description: 'For edit + pdf only. {fields:[{name,value}], texts:[{text,x,y,size,page}]}',
            properties: {
              fields: { type: 'array', items: { type: 'object' }, description: 'Form fields to fill: {name, value (string or boolean checkbox)}' },
              texts: { type: 'array', items: { type: 'object' }, description: 'Text to draw: {text, x (pt from left), y (pt from top), size (pt), page (1-based)}' }
            }
          },
          font: { type: 'string', description: 'Optional font family for pdf create/edit-texts (e.g. "Microsoft YaHei", "SimSun"). Default: the system font for the current UI language. Omit for Latin-only pdf (uses built-in Helvetica).' }
        },
        required: ['action', 'file_path']
      }
    }
  },
  permission: 'normal',
  getPermission: getOfficePermission,
  execute(args, ctx: ToolContext) {
    const officeArgs = args as unknown as OfficeArgs
    return executeOffice(officeArgs, ctx.workspacePath, ctx.signal)
  }
}
