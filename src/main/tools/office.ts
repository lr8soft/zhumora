// 办公文件工具：docx / xlsx / pptx / pdf 的读写。
// 读：officeparser 转 markdown/csv，pdf 用 pdfjs 抽文本。
// 写：docx(库) 从 markdown 生成，xlsx-populate 从 CSV 生成/按单元格编辑，
//     pptxgenjs 从 JSON slides 生成，pdf-lib 画文本/填表单（字体取系统字体）。
// 全部纯 JS 库；库按需懒加载，不拖慢主进程启动。
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

const MAX_OUTPUT_BYTES = 50 * 1024
const MAX_READ_PAGES = 200

type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'

const FORMAT_BY_EXT: Record<string, OfficeFormat> = {
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
  '.pdf': 'pdf'
}

function detectFormat(filePath: string, explicit?: string): OfficeFormat {
  if (explicit) {
    const f = explicit.toLowerCase()
    if (f in FORMAT_BY_EXT) return f as OfficeFormat
    throw new Error(`Unsupported office format: ${explicit}`)
  }
  const f = FORMAT_BY_EXT[path.extname(filePath).toLowerCase()]
  if (!f) throw new Error(`Unsupported office file extension: ${path.extname(filePath)} (expected .docx/.xlsx/.pptx/.pdf)`)
  return f
}

function truncateOutput(text: string, hint: string): string {
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text
  let cut = text
  while (Buffer.byteLength(cut) > MAX_OUTPUT_BYTES && cut.length) cut = cut.slice(0, Math.floor(cut.length * 0.95))
  return cut + `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes — ${hint}]`
}

// ============================================================
// 读取
// ============================================================

async function readOfficeFile(filePath: string, format: OfficeFormat): Promise<string> {
  await fs.access(filePath)
  if (format === 'pdf') return readPdf(filePath)

  const { OfficeParser, OfficeGenerator } = await import('officeparser')
  const ast = await OfficeParser.parseOffice(filePath)
  const genFormat = format === 'xlsx' ? 'csv' : 'md'
  const { value } = await OfficeGenerator.generate(ast, genFormat)
  let text = String(value ?? '')
  if (format === 'pptx') text = cleanPptxMarkdown(text)
  return truncateOutput(text, 'narrow your scope instead of re-reading the whole file')
}

/** 清洗 officeparser 对 pptx 的输出：去掉 front-matter 与 Note 伪影，按 slide 分段 */
function cleanPptxMarkdown(text: string): string {
  const lines = text.split('\n')

  // 1) 跳过 front-matter（第一个 --- 到第二个 ---）
  let start = 0
  let dashes = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      dashes++
      if (dashes === 2) { start = i + 1; break }
    }
  }

  // 2) 其余内容按 --- 分段为 slide
  const slides: string[] = []
  let current: string[] = []
  const flush = () => {
    const body = current
      .filter(l => !/^>\s*\*\*Note:\*\*/.test(l.trim()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (body) slides.push(body)
    current = []
  }
  for (const raw of lines.slice(start)) {
    if (raw.trim() === '---') flush()
    else current.push(raw)
  }
  flush()

  return slides.map((body, i) => `## Slide ${i + 1}\n\n${body}`).join('\n\n')
}

/** pdf 文本抽取：按行 Y 坐标重排，输出分页文本 */
async function readPdf(filePath: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await fs.readFile(filePath))
  // 文本抽取不依赖字体渲染；base14（Helvetica 等）PDF 会打一条无害的
  // standardFontDataUrl 警告（Node 下 fetch 不读 file://），不影响结果。
  const task = pdfjs.getDocument({ data })
  const pdfDoc = await task.promise
  const total = pdfDoc.numPages
  const pageCount = Math.min(total, MAX_READ_PAGES)
  const pages: string[] = []
  let totalBytes = 0
  let stopped = false
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDoc.getPage(i)
    const { items } = await page.getTextContent()
    let text = ''
    let lastY: number | null = null
    for (const item of items) {
      // 仅处理文本项（跳过 marked-content 等）
      if (!('str' in item) || typeof item.str !== 'string') continue
      const y = (item as { transform?: number[] }).transform?.[5]
      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) text += '\n'
      else if (text && !text.endsWith('\n') && !text.endsWith(' ')) text += ' '
      text += item.str
      if (y !== undefined) lastY = y
    }
    const pageText = `--- page ${i} ---\n${text.trim()}`
    pages.push(pageText)
    totalBytes += Buffer.byteLength(pageText)
    if (totalBytes > MAX_OUTPUT_BYTES) { stopped = true; break }
  }
  ;(pdfDoc as unknown as { destroy?: () => void }).destroy?.()
  const notes: string[] = []
  if (total > pageCount) notes.push(`only first ${pageCount} of ${total} pages`)
  if (stopped && total > pages.length) notes.push(`stopped at ${pages.length}/${total} pages (size limit)`)
  let output = pages.join('\n\n')
  if (notes.length) output += `\n[${notes.join('; ')}]`
  return truncateOutput(output, 'the document is large; read it in parts if supported')
}

// ============================================================
// 创建
// ============================================================

async function createOfficeFile(filePath: string, format: OfficeFormat, content: string, font?: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  if (format === 'docx') await writeDocxFromMarkdown(filePath, content)
  else if (format === 'xlsx') await writeXlsxFromCsv(filePath, content)
  else if (format === 'pptx') await writePptxFromSlides(filePath, content)
  else await writePdfFromText(filePath, content, font)
  const stat = await fs.stat(filePath)
  return `Created ${format} file: ${filePath} (${stat.size} bytes)`
}

// ---------- docx：markdown 子集 → docx ----------

interface MarkdownBlock {
  kind: 'heading' | 'paragraph' | 'bullet' | 'numbered' | 'table'
  level?: number
  text?: string
  rows?: string[][]
}

function parseMarkdownBlocks(md: string): MarkdownBlock[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trim()
    if (!trimmed) { i++; continue }

    const h = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      blocks.push({ kind: 'heading', level: Math.min(h[1].length, 4), text: h[2] })
      i++
      continue
    }

    if (trimmed.startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
        if (!cells.every(c => /^:?-{2,}:?$/.test(c))) rows.push(cells)
        i++
      }
      if (rows.length) blocks.push({ kind: 'table', rows })
      continue
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/)
    if (bullet) { blocks.push({ kind: 'bullet', text: bullet[1] }); i++; continue }

    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (numbered) { blocks.push({ kind: 'numbered', text: numbered[1] }); i++; continue }

    const para: string[] = [trimmed]
    i++
    while (
      i < lines.length && lines[i].trim()
      && !lines[i].trim().startsWith('#')
      && !lines[i].trim().startsWith('|')
      && !/^[-*]\s+/.test(lines[i].trim())
      && !/^\d+[.)]\s+/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim())
      i++
    }
    blocks.push({ kind: 'paragraph', text: para.join(' ') })
  }
  return blocks
}

/** 行内 markdown → docx TextRun（支持 **bold** / *italic*） */
function inlineRuns(docx: typeof import('docx'), text: string) {
  const { TextRun } = docx
  const runs = []
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*)/g
  let last = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) runs.push(new TextRun(text.slice(last, match.index)))
    const token = match[0]
    if (token.startsWith('**')) runs.push(new TextRun({ text: token.slice(2, -2), bold: true }))
    else runs.push(new TextRun({ text: token.slice(1, -1), italics: true }))
    last = match.index + token.length
  }
  if (last < text.length) runs.push(new TextRun(text.slice(last)))
  return runs.length ? runs : [new TextRun('')]
}

async function writeDocxFromMarkdown(filePath: string, md: string): Promise<void> {
  const docx = await import('docx')
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel } = docx
  const blocks = parseMarkdownBlocks(md)
  const children = []
  for (const block of blocks) {
    if (block.kind === 'heading') {
      const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4]
      children.push(new Paragraph({ heading: levels[(block.level || 1) - 1], children: [new TextRun(block.text || '')] }))
    } else if (block.kind === 'paragraph') {
      children.push(new Paragraph({ children: inlineRuns(docx, block.text || '') }))
    } else if (block.kind === 'bullet') {
      children.push(new Paragraph({ bullet: { level: 0 }, children: inlineRuns(docx, block.text || '') }))
    } else if (block.kind === 'numbered') {
      children.push(new Paragraph({ numbering: { reference: 'office-numbered', level: 0 }, children: inlineRuns(docx, block.text || '') }))
    } else if (block.kind === 'table') {
      const rows = block.rows || []
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: rows.map((cells, index) => new TableRow({
          children: cells.map(cell => new TableCell({
            children: [new Paragraph({ children: index === 0 ? [new TextRun({ text: cell, bold: true })] : inlineRuns(docx, cell) })]
          }))
        }))
      }))
      children.push(new Paragraph(''))
    }
  }
  const doc = new Document({
    numbering: {
      config: [{
        reference: 'office-numbered',
        levels: [{
          level: 0,
          format: 'decimal' as const,
          text: '%1.',
          alignment: 'start' as const,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } }
        }]
      }]
    },
    sections: [{ children: children.length ? children : [new Paragraph('')] }]
  })
  await fs.writeFile(filePath, await Packer.toBuffer(doc))
}

// ---------- xlsx：CSV（多 sheet 用 "# Sheet: 名" 行分隔）→ xlsx ----------

function colName(index: number): string {
  let name = ''
  let n = index
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  }
  return name
}

function cellValue(raw: string): string | number | boolean | null {
  if (raw === '') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true'
  return raw
}

function splitCsvSheets(csv: string): { name: string; body: string }[] {
  const lines = csv.replace(/\r\n/g, '\n').split('\n')
  const sections: { name: string; body: string[] }[] = []
  let current: { name: string; body: string[] } = { name: '', body: [] }
  for (const line of lines) {
    const marker = line.match(/^#\s*Sheet:\s*(.+)$/i)
    if (marker) {
      if (current.body.length || current.name) sections.push(current)
      current = { name: marker[1].trim(), body: [] }
    } else {
      current.body.push(line)
    }
  }
  if (current.body.length || current.name) sections.push(current)
  return sections.map(s => ({ name: s.name, body: s.body.join('\n') }))
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') { cell += '"'; i++ }
        else inQuotes = false
      } else cell += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); if (row.some(c => c !== '')) rows.push(row); row = []; cell = '' }
    else if (ch !== '\r') cell += ch
  }
  row.push(cell)
  if (row.some(c => c !== '')) rows.push(row)
  return rows
}

async function writeXlsxFromCsv(filePath: string, csv: string): Promise<void> {
  const XlsxPopulate = (await import('xlsx-populate')).default
  const sections = splitCsvSheets(csv)
  const workbook = await XlsxPopulate.fromBlankAsync()
  sections.forEach((section, index) => {
    const sheetName = section.name || `Sheet${index + 1}`
    let sheet
    try { sheet = workbook.sheet(sheetName) } catch { sheet = undefined }
    if (!sheet) sheet = workbook.addSheet(sheetName)
    const rows = parseCsvRows(section.body)
    rows.forEach((row, r) => {
      row.forEach((cell, c) => {
        const value = cellValue(cell)
        if (value !== null) sheet.cell(`${colName(c)}${r + 1}`).value(value)
      })
    })
  })
  await workbook.toFileAsync(filePath)
}

// ---------- pptx：JSON slides → pptx ----------

interface PptxSlideSpec {
  title?: string
  bullets?: string[]
  table?: { header?: string[]; rows?: string[][] }
  notes?: string
}

async function writePptxFromSlides(filePath: string, content: string): Promise<void> {
  let slides: PptxSlideSpec[]
  try {
    slides = JSON.parse(content)
  } catch (error) {
    throw new Error(`pptx content must be a JSON array of slides: ${(error as Error).message}`)
  }
  if (!Array.isArray(slides) || !slides.length) throw new Error('pptx content must be a non-empty JSON array of slides')
  const PptxGenJS = (await import('pptxgenjs')).default
  const pres = new PptxGenJS()
  for (const spec of slides) {
    if (typeof spec !== 'object' || spec === null) throw new Error('each slide must be an object like {title, bullets, table}')
    const slide = pres.addSlide()
    let cursorY = 0.6
    if (spec.title) {
      slide.addText(String(spec.title), { x: 0.5, y: 0.35, w: 9, h: 0.9, fontSize: 30, bold: true, color: '222222' })
      cursorY = 1.5
    }
    if (spec.bullets?.length) {
      slide.addText(
        spec.bullets.map(b => ({ text: String(b), options: { bullet: true, breakLine: true, paraSpaceAfter: 6 } })),
        { x: 0.7, y: cursorY, w: 8.8, h: 5.2, fontSize: 16, color: '333333' }
      )
      cursorY += 0.3 + spec.bullets.length * 0.4
    }
    if (spec.table) {
      const header = (spec.table.header || []).map(String)
      const rows = (spec.table.rows || []).map(r => (r || []).map(String))
      const all: string[][] = header.length ? [header, ...rows] : rows
      if (all.length) {
        slide.addTable(all as never, { x: 0.7, y: Math.min(cursorY, 5.4), w: 8.8, fontSize: 13, border: { pt: 0.5, color: '999999' } })
      }
    }
    if (spec.notes) slide.addNotes(String(spec.notes))
  }
  await pres.writeFile({ fileName: filePath })
}

// ---------- pdf：文本 → pdf（中文用系统字体） ----------

const CJK_CHAR = /[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/

async function writePdfFromText(filePath: string, text: string, fontQuery?: string): Promise<void> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const pdfDoc = await PDFDocument.create()
  let font
  if (CJK_CHAR.test(text) || fontQuery) {
    const fontkit = (await import('@pdf-lib/fontkit')).default
    pdfDoc.registerFontkit(fontkit)
    const { loadEmbeddableFont } = await import('./officeFonts.ts')
    const { bytes } = await loadEmbeddableFont(fontQuery)
    try { font = await pdfDoc.embedFont(bytes, { subset: true }) }
    catch { font = await pdfDoc.embedFont(bytes) }
  } else {
    font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  }

  const pageWidth = 595.28 // A4
  const pageHeight = 841.89
  const margin = 56
  const lineHeight = 18
  let page = pdfDoc.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    if (y < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight])
      y = pageHeight - margin
    }
    page.drawText(rawLine || ' ', { x: margin, y, size: 11, font, color: rgb(0.13, 0.13, 0.13) })
    y -= lineHeight
  }
  await fs.writeFile(filePath, await pdfDoc.save())
}

// ============================================================
// 编辑
// ============================================================

interface XlsxOp {
  sheet?: string
  cell?: string
  value?: unknown
  formula?: string
  addSheet?: boolean
  deleteSheet?: boolean
}

async function editXlsx(filePath: string, ops: XlsxOp[]): Promise<string> {
  await fs.access(filePath)
  const XlsxPopulate = (await import('xlsx-populate')).default
  const workbook = await XlsxPopulate.fromFileAsync(filePath)
  const done: string[] = []
  for (const op of ops) {
    if (typeof op !== 'object' || op === null) throw new Error('each xlsx op must be an object')
    const sheetName = op.sheet || (workbook.sheets()[0]?.name() as string) || 'Sheet1'
    if (op.addSheet) {
      workbook.addSheet(sheetName)
      done.push(`added sheet "${sheetName}"`)
      continue
    }
    if (op.deleteSheet) {
      workbook.deleteSheet(sheetName)
      done.push(`deleted sheet "${sheetName}"`)
      continue
    }
    if (!op.cell) throw new Error('xlsx op requires "cell" (or addSheet/deleteSheet)')
    let sheet
    try { sheet = workbook.sheet(sheetName) } catch { sheet = undefined }
    if (!sheet) throw new Error(`sheet "${sheetName}" not found (available: ${workbook.sheets().map(s => s.name()).join(', ')})`)
    if (op.formula !== undefined) {
      sheet.cell(op.cell).formula(String(op.formula))
      done.push(`${sheetName}!${op.cell} = ${op.formula}`)
    }
    if (op.value !== undefined) {
      const v = op.value
      if (v === null || v === '') sheet.cell(op.cell).value(null)
      else if (typeof v === 'number' || typeof v === 'boolean') sheet.cell(op.cell).value(v)
      else sheet.cell(op.cell).value(String(v))
      done.push(`${sheetName}!${op.cell} = ${JSON.stringify(v)}`)
    }
  }
  await workbook.toFileAsync(filePath)
  return `Edited xlsx: ${filePath}\n${done.join('\n')}\nNote: formula results stay as last calculated by Excel (xlsx-populate does not recalculate).`
}

interface PdfEditOp {
  fields?: { name: string; value: string | boolean }[]
  texts?: { x?: number; y?: number; size?: number; page?: number; text: string }[]
}

async function editPdf(filePath: string, edit: PdfEditOp, fontQuery?: string): Promise<string> {
  await fs.access(filePath)
  const { PDFDocument, rgb } = await import('pdf-lib')
  const pdfDoc = await PDFDocument.load(await fs.readFile(filePath))
  const done: string[] = []

  if (edit.texts?.length) {
    const fontkit = (await import('@pdf-lib/fontkit')).default
    pdfDoc.registerFontkit(fontkit)
    const { loadEmbeddableFont } = await import('./officeFonts.ts')
    const { bytes } = await loadEmbeddableFont(fontQuery)
    let font
    try { font = await pdfDoc.embedFont(bytes, { subset: true }) }
    catch { font = await pdfDoc.embedFont(bytes) }
    const count = pdfDoc.getPageCount()
    for (const t of edit.texts) {
      if (!t?.text) throw new Error('each pdf text op needs "text"')
      // 用户页码 1-based，pdf-lib getPage 是 0-based
      const pageIndex = Math.min(Math.max(1, Math.floor(t.page || 1)), count)
      const page = pdfDoc.getPage(pageIndex - 1)
      const { height } = page.getSize()
      page.drawText(String(t.text), {
        x: t.x ?? 56,
        y: height - (t.y ?? 72),
        size: t.size ?? 11,
        font,
        color: rgb(0.13, 0.13, 0.13)
      })
      done.push(`drew text on page ${pageIndex}`)
    }
  }

  if (edit.fields?.length) {
    const form = pdfDoc.getForm()
    for (const f of edit.fields) {
      if (!f?.name) throw new Error('each pdf field op needs "name" and "value"')
      if (typeof f.value === 'boolean') {
        const cb = form.getCheckBox(f.name)
        if (f.value) cb.check(); else cb.uncheck()
        done.push(`checkbox "${f.name}" ${f.value ? 'checked' : 'unchecked'}`)
      } else {
        form.getTextField(f.name).setText(String(f.value))
        done.push(`field "${f.name}" = ${JSON.stringify(f.value)}`)
      }
    }
    done.push('note: form field text renders in Helvetica (Latin only); use "texts" for CJK')
  }

  if (!done.length) throw new Error('pdf edit needs "edit.fields" and/or "edit.texts"')
  await fs.writeFile(filePath, await pdfDoc.save())
  return `Edited pdf: ${filePath}\n${done.join('\n')}`
}

// ============================================================
// 统一入口
// ============================================================

export interface OfficeArgs {
  action: string
  file_path: string
  format?: string
  content?: string
  font?: string
  ops?: XlsxOp[]
  edit?: PdfEditOp
}

export async function executeOffice(args: OfficeArgs, workspacePath: string, signal?: AbortSignal): Promise<string> {
  const action = args.action
  if (signal?.aborted) throw new Error('Office operation aborted')
  if (!args.file_path?.trim()) throw new Error('file_path is required')
  const filePath = path.resolve(workspacePath, args.file_path)
  const format = detectFormat(filePath, args.format)

  if (action === 'read') return readOfficeFile(filePath, format)

  if (action === 'create') {
    if (!args.content?.trim()) throw new Error('create requires "content"')
    return createOfficeFile(filePath, format, args.content, args.font)
  }

  if (action === 'edit') {
    if (format === 'xlsx') {
      if (!Array.isArray(args.ops) || !args.ops.length) throw new Error('xlsx edit requires an "ops" array')
      return editXlsx(filePath, args.ops)
    }
    if (format === 'pdf') {
      if (!args.edit || (!args.edit.fields?.length && !args.edit.texts?.length)) {
        throw new Error('pdf edit requires "edit.fields" and/or "edit.texts"')
      }
      return editPdf(filePath, args.edit, args.font)
    }
    throw new Error(`In-place editing is only supported for xlsx and pdf. ${format} cannot be edited in place — read it, then create a new file with the updated content.`)
  }

  throw new Error(`Unknown action: ${action} (expected read/create/edit)`)
}
