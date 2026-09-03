// Model-facing Office tool definitions.
// The implementation lives in office.ts; this module keeps schemas small and
// format-specific so smaller models do not have to decode four mini-languages
// inside one generic tool.
import * as path from 'node:path'
import type { ToolHandler, ToolContext } from './registry.ts'
import { executeOffice, type OfficeArgs } from './office.ts'

type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'

const EXTENSION_BY_FORMAT: Record<OfficeFormat, string> = {
  docx: '.docx',
  xlsx: '.xlsx',
  pptx: '.pptx',
  pdf: '.pdf'
}

function getOfficePermission(args: Record<string, unknown>): 'safe' | 'normal' {
  return args.action === 'read' ? 'safe' : 'normal'
}

async function executeFormatTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
  format: OfficeFormat
): Promise<string> {
  const filePath = String(args.file_path || '')
  const expectedExtension = EXTENSION_BY_FORMAT[format]
  if (filePath && path.extname(filePath).toLowerCase() !== expectedExtension) {
    throw new Error(`This tool only accepts ${expectedExtension} files; got: ${filePath}`)
  }
  const officeArgs = {
    ...args,
    action: args.action === 'create_or_replace' ? 'create' : args.action
  } as unknown as OfficeArgs
  return executeOffice(officeArgs, ctx.workspacePath, ctx.signal)
}

const filePathProperty = (extension: string) => ({
  type: 'string',
  description: `Absolute path or workspace-relative path. Must end in ${extension}.`
})

export const wordDocumentTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'word_document',
      description: [
        'Read or create/replace a Microsoft Word .docx artifact. Use this for Word-document work, not shell or code tools.',
        'read extracts document content as Markdown-like text.',
        'create_or_replace writes content using a Markdown subset: headings, paragraphs, bullets, numbered lists, bold, italic, and tables.',
        'Existing complex styling is not preserved when replacing a document. Inspect an existing file before replacing it.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'create_or_replace'],
            description: 'read extracts content; create_or_replace writes the complete document and overwrites an existing file.'
          },
          file_path: filePathProperty('.docx'),
          content: {
            type: 'string',
            description: 'Required for create_or_replace. Complete document in the supported Markdown subset.'
          }
        },
        required: ['action', 'file_path'],
        additionalProperties: false
      }
    }
  },
  permission: 'normal',
  getPermission: getOfficePermission,
  execute(args, ctx) {
    return executeFormatTool(args, ctx, 'docx')
  }
}

export const excelWorkbookTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'excel_workbook',
      description: [
        'Read, create/replace, or edit a Microsoft Excel .xlsx artifact. Use this for workbook work, not shell or code tools.',
        'read returns sheets as CSV. create_or_replace accepts CSV; start a sheet with "# Sheet: Name" for multiple sheets.',
        'edit changes values/formulas or adds/deletes sheets in place and preserves existing formatting. Formula results are not recalculated.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'create_or_replace', 'edit'],
            description: 'Operation to perform on the workbook.'
          },
          file_path: filePathProperty('.xlsx'),
          content: {
            type: 'string',
            description: 'Required for create_or_replace. CSV content; use "# Sheet: Name" lines to separate sheets.'
          },
          ops: {
            type: 'array',
            minItems: 1,
            description: 'Required for edit. Each item changes one cell or adds/deletes one sheet.',
            items: {
              type: 'object',
              properties: {
                sheet: { type: 'string', description: 'Sheet name. Defaults to the first sheet for cell changes.' },
                cell: { type: 'string', description: 'A1-style cell address, for example B4.' },
                value: { description: 'Cell value. Use null or an empty string to clear the cell.' },
                formula: { type: 'string', description: 'Formula without a leading equals sign, for example SUM(B2:B4).' },
                addSheet: { type: 'boolean', description: 'Set true to add the named sheet.' },
                deleteSheet: { type: 'boolean', description: 'Set true to delete the named sheet.' }
              },
              additionalProperties: false
            }
          }
        },
        required: ['action', 'file_path'],
        additionalProperties: false
      }
    }
  },
  permission: 'normal',
  getPermission: getOfficePermission,
  execute(args, ctx) {
    return executeFormatTool(args, ctx, 'xlsx')
  }
}

export const powerpointPresentationTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'powerpoint_presentation',
      description: [
        'Read or create/replace a Microsoft PowerPoint .pptx artifact. Use this for presentation work, not shell or code tools.',
        'read extracts slide text and tables. create_or_replace accepts a JSON array of slides.',
        'Each slide supports title, subtitle, bullets, table {header, rows}, and notes. Choose a built-in theme for consistent colors and typography.',
        'Existing complex styling is not preserved when replacing a deck.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'create_or_replace'],
            description: 'read extracts content; create_or_replace writes the complete deck and overwrites an existing file.'
          },
          file_path: filePathProperty('.pptx'),
          content: {
            type: 'string',
            description: 'Required for create_or_replace. JSON array such as [{"title":"Title","subtitle":"Context","bullets":["Point"],"table":{"header":["A"],"rows":[["B"]]},"notes":"..."}].'
          },
          theme: {
            type: 'string',
            enum: ['modern_blue', 'dark_tech', 'warm_minimal', 'forest', 'corporate'],
            description: 'Visual theme for create_or_replace. Default: modern_blue.'
          },
          font: {
            type: 'string',
            description: 'Optional installed font family. Default: Microsoft YaHei.'
          }
        },
        required: ['action', 'file_path'],
        additionalProperties: false
      }
    }
  },
  permission: 'normal',
  getPermission: getOfficePermission,
  execute(args, ctx) {
    return executeFormatTool(args, ctx, 'pptx')
  }
}

export const pdfDocumentTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'pdf_document',
      description: [
        'Read, create/replace, or edit a PDF .pdf artifact. Use this for PDF work, not shell or code tools.',
        'read extracts per-page text. create_or_replace creates an auto-paginated PDF from plain text.',
        'edit fills existing form fields or draws text at page coordinates. It does not reflow or redesign an existing PDF.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'create_or_replace', 'edit'],
            description: 'Operation to perform on the PDF.'
          },
          file_path: filePathProperty('.pdf'),
          content: {
            type: 'string',
            description: 'Required for create_or_replace. Plain text, one visual row per line.'
          },
          font: {
            type: 'string',
            description: 'Optional installed font family for CJK creation or drawn edit text, for example Microsoft YaHei.'
          },
          edit: {
            type: 'object',
            description: 'Required for edit. Fill fields and/or draw text.',
            properties: {
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Existing PDF form-field name.' },
                    value: { description: 'String for a text field or boolean for a checkbox.' }
                  },
                  required: ['name', 'value'],
                  additionalProperties: false
                }
              },
              texts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    x: { type: 'number', description: 'Points from the left; default 56.' },
                    y: { type: 'number', description: 'Points from the top; default 72.' },
                    size: { type: 'number', description: 'Font size in points; default 11.' },
                    page: { type: 'integer', minimum: 1, description: 'One-based page number; default 1.' }
                  },
                  required: ['text'],
                  additionalProperties: false
                }
              }
            },
            additionalProperties: false
          }
        },
        required: ['action', 'file_path'],
        additionalProperties: false
      }
    }
  },
  permission: 'normal',
  getPermission: getOfficePermission,
  execute(args, ctx) {
    return executeFormatTool(args, ctx, 'pdf')
  }
}

export const officeTools: { name: string; handler: ToolHandler }[] = [
  { name: 'word_document', handler: wordDocumentTool },
  { name: 'excel_workbook', handler: excelWorkbookTool },
  { name: 'powerpoint_presentation', handler: powerpointPresentationTool },
  { name: 'pdf_document', handler: pdfDocumentTool }
]

/** Legacy generic definition retained for direct API/tests; it is no longer registered for model selection. */
export const officeTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'office',
      description: 'Legacy generic Office tool. Prefer the format-specific Word, Excel, PowerPoint, or PDF tool.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'create', 'edit'] },
          file_path: { type: 'string' },
          content: { type: 'string' },
          ops: { type: 'array', items: { type: 'object' } },
          edit: { type: 'object' },
          font: { type: 'string' },
          theme: { type: 'string' }
        },
        required: ['action', 'file_path']
      }
    }
  },
  permission: 'normal',
  getPermission: getOfficePermission,
  execute(args, ctx) {
    return executeOffice(args as unknown as OfficeArgs, ctx.workspacePath, ctx.signal)
  }
}
