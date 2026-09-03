import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { executeOffice } from '../src/main/tools/office.ts'
import { officeTool, officeTools } from '../src/main/tools/officeTool.ts'
import { splitFontCollection } from '../src/main/tools/officeFonts.ts'
import { getToolPermission } from '../src/main/tools/registry.ts'
import { registerTool } from '../src/main/tools/registry.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zhumora-office-'))
const R: [string, boolean, string][] = []
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); R.push([name, true, '']) }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    R.push([name, false, message.slice(0, 200)])
  }
}

// ============================================================
// 权限模型
// ============================================================
registerTool('office', officeTool, 'builtin')
for (const { name, handler } of officeTools) registerTool(name, handler, 'builtin')
await check('permission: read=safe', async () => {
  assert.equal(getToolPermission('office', { action: 'read', file_path: 'a.docx' }), 'safe')
})
await check('permission: create=normal', async () => {
  assert.equal(getToolPermission('office', { action: 'create', file_path: 'a.docx', content: 'x' }), 'normal')
})
await check('permission: edit=normal', async () => {
  assert.equal(getToolPermission('office', { action: 'edit', file_path: 'a.xlsx' }), 'normal')
})
// 无 args 回退静态 permission
assert.equal(getToolPermission('office'), 'normal')
await check('format-specific permissions', async () => {
  assert.equal(getToolPermission('word_document', { action: 'read', file_path: 'a.docx' }), 'safe')
  assert.equal(getToolPermission('powerpoint_presentation', { action: 'create_or_replace', file_path: 'a.pptx' }), 'normal')
})

// ============================================================
// docx
// ============================================================
const docxPath = path.join(root, 'report.docx')
await check('docx create from markdown', async () => {
  const md = [
    '# 季度报告',
    '',
    '这是**加粗**和*斜体*的段落。',
    '',
    '## 要点',
    '- 第一项',
    '- 第二项',
    '',
    '1. 步骤一',
    '2. 步骤二',
    '',
    '| 指标 | 数值 |',
    '| --- | --- |',
    '| 收入 | 120万 |'
  ].join('\n')
  const result = await executeOffice({ action: 'create', file_path: docxPath, content: md }, root)
  assert.match(result, /Created docx/)
  const stat = await fs.stat(docxPath)
  assert.ok(stat.size > 500)
})

await check('docx read back', async () => {
  const text = await executeOffice({ action: 'read', file_path: docxPath }, root)
  assert.match(text, /季度报告/)
  assert.match(text, /加粗/)
  assert.match(text, /第一项/)
  assert.match(text, /收入/)
  assert.match(text, /120万/)
})

await check('word_document create_or_replace maps to create', async () => {
  const wrapped = path.join(root, 'wrapped.docx')
  const handler = officeTools.find(tool => tool.name === 'word_document')!.handler
  await handler.execute({ action: 'create_or_replace', file_path: wrapped, content: '# Wrapped' }, { workspacePath: root })
  assert.match(await executeOffice({ action: 'read', file_path: wrapped }, root), /Wrapped/)
  await assert.rejects(
    () => handler.execute({ action: 'read', file_path: path.join(root, 'wrong.pdf') }, { workspacePath: root }),
    /only accepts \.docx/
  )
})

await check('docx nested dir + overwrite', async () => {
  const nested = path.join(root, 'sub', 'dir', 'doc.docx')
  await executeOffice({ action: 'create', file_path: nested, content: '# A' }, root)
  await executeOffice({ action: 'create', file_path: nested, content: '# B' }, root)
  const text = await executeOffice({ action: 'read', file_path: nested }, root)
  assert.match(text, /B/)
  assert.doesNotMatch(text, /# A/)
})

// ============================================================
// xlsx
// ============================================================
const xlsxPath = path.join(root, 'scores.xlsx')
await check('xlsx create from csv (multi sheet)', async () => {
  const csv = [
    '# Sheet: 学生',
    '姓名,分数',
    '张三,88',
    '李四,95',
    '',
    '# Sheet: 汇总',
    '平均分,91.5'
  ].join('\n')
  const result = await executeOffice({ action: 'create', file_path: xlsxPath, content: csv }, root)
  assert.match(result, /Created xlsx/)
})

await check('xlsx read back (csv, both sheets, typed)', async () => {
  const text = await executeOffice({ action: 'read', file_path: xlsxPath }, root)
  assert.match(text, /# Sheet: 学生/i)
  assert.match(text, /姓名,分数/)
  assert.match(text, /张三,88/)
  assert.match(text, /# Sheet: 汇总/i)
  assert.match(text, /91\.5/)
})

await check('xlsx edit (cell value + formula + addSheet)', async () => {
  const result = await executeOffice({
    action: 'edit',
    file_path: xlsxPath,
    ops: [
      { sheet: '学生', cell: 'A4', value: '王五' },
      { sheet: '学生', cell: 'B4', value: 70 },
      { sheet: '学生', cell: 'B5', formula: 'SUM(B2:B4)' },
      { sheet: '新增', addSheet: true }
    ]
  }, root)
  assert.match(result, /Edited xlsx/)
  const text = await executeOffice({ action: 'read', file_path: xlsxPath }, root)
  assert.match(text, /王五,70/)
  assert.match(text, /# Sheet: 新增/i)
})

await check('xlsx edit missing cell rejected', async () => {
  await assert.rejects(
    () => executeOffice({ action: 'edit', file_path: xlsxPath, ops: [{ value: 1 }] }, root),
    /requires "cell"/
  )
})

// ============================================================
// pptx
// ============================================================
const pptxPath = path.join(root, 'deck.pptx')
await check('pptx create from JSON slides', async () => {
  const content = JSON.stringify([
    { title: '产品发布会', bullets: ['要点一', '要点二'] },
    { title: '数据页', table: { header: ['Q1', 'Q2'], rows: [['10', '20']] }, notes: '备注内容' }
  ])
  const result = await executeOffice({ action: 'create', file_path: pptxPath, content }, root)
  assert.match(result, /Created pptx/)
})

await check('pptx read back (slides + table)', async () => {
  const text = await executeOffice({ action: 'read', file_path: pptxPath }, root)
  assert.match(text, /## Slide 1/)
  assert.match(text, /产品发布会/)
  assert.match(text, /要点一/)
  assert.match(text, /## Slide 2/)
  assert.match(text, /数据页/)
  assert.match(text, /Q1/)
})

await check('pptx built-in theme + subtitle', async () => {
  const themed = path.join(root, 'themed.pptx')
  const content = JSON.stringify([{ title: '深色主题', subtitle: '自动配色', bullets: ['统一字体', '强调色'] }])
  await executeOffice({ action: 'create', file_path: themed, content, theme: 'dark_tech' }, root)
  const text = await executeOffice({ action: 'read', file_path: themed }, root)
  assert.match(text, /深色主题/)
  assert.match(text, /自动配色/)
  await assert.rejects(
    () => executeOffice({ action: 'create', file_path: path.join(root, 'bad-theme.pptx'), content, theme: 'unknown' }, root),
    /Unknown pptx theme/
  )
})

await check('pptx bad JSON rejected', async () => {
  await assert.rejects(
    () => executeOffice({ action: 'create', file_path: path.join(root, 'bad.pptx'), content: '{not json' }, root),
    /JSON array of slides/
  )
})

// ============================================================
// pdf
// ============================================================
const pdfPath = path.join(root, 'cn.pdf')
await check('pdf create with CJK (system font)', async () => {
  const content = '中文 PDF 标题：季度经营报告\n\n本季度营收同比增长 25%，用户数突破一百万。\n第三行内容。'
  const result = await executeOffice({ action: 'create', file_path: pdfPath, content }, root)
  assert.match(result, /Created pdf/)
})

await check('pdf read back (text extracted)', async () => {
  const text = await executeOffice({ action: 'read', file_path: pdfPath }, root)
  assert.match(text, /季度经营报告/)
  assert.match(text, /营收同比增长/)
  assert.match(text, /第三行内容/)
  assert.match(text, /--- page 1 ---/)
})

await check('pdf create Latin (Helvetica, no font embed)', async () => {
  const latin = path.join(root, 'latin.pdf')
  await executeOffice({ action: 'create', file_path: latin, content: 'Hello Latin PDF' }, root)
  const text = await executeOffice({ action: 'read', file_path: latin }, root)
  assert.match(text, /Hello Latin PDF/)
})

await check('pdf create with explicit font', async () => {
  const f = path.join(root, 'fonted.pdf')
  if (process.platform === 'win32') {
    await executeOffice({ action: 'create', file_path: f, content: '指定字体测试', font: 'Microsoft YaHei' }, root)
  } else {
    await executeOffice({ action: 'create', file_path: f, content: 'spec font test' }, root)
  }
  assert.ok((await fs.stat(f)).size > 0)
})

await check('pdf edit: fill form fields (latin) + draw text', async () => {
  const f = path.join(root, 'form.pdf')
  // 先造一个带表单的 pdf
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage()
  const form = doc.getForm()
  const name = form.createTextField('applicant')
  name.addToPage(page, { x: 100, y: 600, width: 200, height: 25 })
  name.setText('')
  const cb = form.createCheckBox('agree')
  cb.addToPage(page, { x: 100, y: 550, width: 20, height: 20 })
  await fs.writeFile(f, await doc.save())

  const result = await executeOffice({
    action: 'edit',
    file_path: f,
    edit: {
      fields: [{ name: 'applicant', value: 'John Doe' }, { name: 'agree', value: true }],
      texts: [{ text: '批注：已审核', x: 100, y: 400, size: 14, page: 1 }]
    }
  }, root)
  assert.match(result, /Edited pdf/)
  assert.match(result, /field "applicant" = "John Doe"/)
  assert.match(result, /checkbox "agree" checked/)

  // 验证
  const doc2 = await PDFDocument.load(await fs.readFile(f))
  const form2 = doc2.getForm()
  assert.equal(form2.getTextField('applicant').getText(), 'John Doe')
  assert.equal(form2.getCheckBox('agree').isChecked(), true)
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(f)) })
  const p1 = await (await task.promise).getPage(1)
  const { items } = await p1.getTextContent()
  const all = items.map(i => i.str).join('')
  assert.match(all, /已审核/)
})

await check('pdf edit missing ops rejected', async () => {
  await assert.rejects(
    () => executeOffice({ action: 'edit', file_path: pdfPath, edit: {} }, root),
    /requires "edit\.fields" and\/or "edit\.texts"/
  )
})

// ============================================================
// 通用错误处理
// ============================================================
await check('unsupported extension rejected', async () => {
  await assert.rejects(
    () => executeOffice({ action: 'read', file_path: 'a.txt' }, root),
    /Unsupported office file extension/
  )
})

await check('docx in-place edit rejected with guidance', async () => {
  await assert.rejects(
    () => executeOffice({ action: 'edit', file_path: docxPath, ops: [] }, root),
    /cannot be edited in place/
  )
})

await check('unknown action rejected', async () => {
  await assert.rejects(
    () => executeOffice({ action: 'destroy', file_path: docxPath }, root as never),
    /Unknown action/
  )
})

await check('missing file rejected', async () => {
  await assert.rejects(
    () => executeOffice({ action: 'read', file_path: path.join(root, 'nope.docx') }, root),
    /ENOENT/
  )
})

await check('create without content rejected', async () => {
  await assert.rejects(
    () => executeOffice({ action: 'create', file_path: path.join(root, 'x.docx') }, root),
    /create requires "content"/
  )
})

// ============================================================
// TTC 集合拆分（字体嵌入基础）
// ============================================================
await check('TTC split produces parseable subfonts', async () => {
  if (process.platform !== 'win32') return // 仅 Windows 有 msyh.ttc
  const ttc = await fs.readFile('C:/Windows/Fonts/msyh.ttc')
  const subs = splitFontCollection(ttc)
  assert.ok(subs && subs.length === 2)
  const { default: pdfFontkit } = await import('@pdf-lib/fontkit')
  const names: string[] = []
  for (const s of subs) names.push((await pdfFontkit.create(s)).postscriptName || '')
  assert.ok(names.some(n => n.includes('MicrosoftYaHei')), `got: ${names.join(',')}`)
})

await check('non-collection returns null', async () => {
  const ttf = Buffer.from([0x00, 0x01, 0x00, 0x00])
  assert.equal(splitFontCollection(ttf), null)
})

// ============================================================
// 结果输出
// ============================================================
console.log('office tools tests')
let failed = 0
for (const [name, ok, detail] of R) {
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log(`\nall ${R.length} office tests passed`)
