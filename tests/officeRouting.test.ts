import assert from 'node:assert/strict'
import { detectOfficeRoute, selectToolsForOfficeRoute } from '../src/main/agent/officeRouting.ts'
import { officeTools } from '../src/main/tools/officeTool.ts'
import type { ToolDefinition } from '../src/shared/types.ts'

const OFFICE_THEMES = ['modern_blue', 'dark_tech', 'warm_minimal', 'forest', 'corporate']

function tool(name: string): ToolDefinition {
  return {
    type: 'function',
    function: { name, description: name, parameters: { type: 'object' } }
  }
}

assert.deepEqual(detectOfficeRoute('请帮我制作一份年度总结 PPT'), {
  toolName: 'powerpoint_presentation',
  format: 'pptx'
})
assert.deepEqual(detectOfficeRoute('美化 D:\\reports\\sales.xlsx'), {
  toolName: 'excel_workbook',
  format: 'xlsx'
})
assert.deepEqual(detectOfficeRoute('不要用 Python，生成 report.docx'), {
  toolName: 'word_document',
  format: 'docx'
})
assert.deepEqual(detectOfficeRoute('不要自己写 Python 脚本，直接制作演示文稿'), {
  toolName: 'powerpoint_presentation',
  format: 'pptx'
})
assert.deepEqual(detectOfficeRoute('Create a capital plan in PowerPoint'), {
  toolName: 'powerpoint_presentation',
  format: 'pptx'
})
assert.deepEqual(detectOfficeRoute('Read and summarize contract.pdf'), {
  toolName: 'pdf_document',
  format: 'pdf'
})
assert.deepEqual(detectOfficeRoute('把颜色调亮一点', 'powerpoint_presentation\ncreated quarterly-review.pptx'), {
  toolName: 'powerpoint_presentation',
  format: 'pptx'
})

assert.equal(detectOfficeRoute('写一个 Python 脚本生成 PPT'), null)
assert.equal(detectOfficeRoute('这个 PDF SDK 应该怎么调用？'), null)
assert.equal(detectOfficeRoute('report.pptx'), null)

const allTools = [
  tool('read'),
  tool('glob'),
  tool('bash'),
  tool('write'),
  tool('memory_save'),
  tool('powerpoint_presentation'),
  tool('excel_workbook'),
  tool('mcp_external')
]
const route = detectOfficeRoute('创建产品介绍.pptx')
const selected = selectToolsForOfficeRoute(allTools, route).map(t => t.function.name)
assert.deepEqual(selected, ['read', 'glob', 'powerpoint_presentation'])

const registeredNames = officeTools.map(entry => entry.name)
assert.deepEqual(registeredNames, [
  'word_document',
  'excel_workbook',
  'powerpoint_presentation',
  'pdf_document'
])

const excel = officeTools.find(entry => entry.name === 'excel_workbook')!
const excelSchema = excel.handler.definition.function.parameters as any
assert.equal(excelSchema.properties.ops.items.properties.cell.type, 'string')
assert.equal(excelSchema.properties.ops.items.properties.formula.type, 'string')

const pdf = officeTools.find(entry => entry.name === 'pdf_document')!
const pdfSchema = pdf.handler.definition.function.parameters as any
assert.deepEqual(pdfSchema.properties.edit.properties.texts.items.required, ['text'])
assert.deepEqual(pdfSchema.properties.edit.properties.fields.items.required, ['name', 'value'])
assert.deepEqual(pdfSchema.properties.theme.enum, OFFICE_THEMES)

const word = officeTools.find(entry => entry.name === 'word_document')!
const wordSchema = word.handler.definition.function.parameters as any
assert.deepEqual(wordSchema.properties.theme.enum, OFFICE_THEMES)

console.log('\noffice routing\n  ✓ artifact routing, code opt-out, tool filtering, and schemas\n\n1 passed, 0 failed')
