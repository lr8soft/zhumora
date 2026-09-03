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

async function createOfficeFile(filePath: string, format: OfficeFormat, content: string, font?: string, theme?: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  if (format === 'docx') await writeDocxFromMarkdown(filePath, content, theme, font)
  else if (format === 'xlsx') await writeXlsxFromCsv(filePath, content)
  else if (format === 'pptx') await writePptxFromSlides(filePath, content, theme, font)
  else await writePdfFromText(filePath, content, font, theme)
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

async function writeDocxFromMarkdown(filePath: string, md: string, themeName?: string, fontFace?: string): Promise<void> {
  const docx = await import('docx')
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    WidthType, HeadingLevel, Header, Footer, AlignmentType, PageNumber,
    ShadingType, BorderStyle
  } = docx
  const theme = resolveOfficeTheme(themeName, 'docx')
  const face = fontFace || 'Microsoft YaHei'
  const blocks = parseMarkdownBlocks(md)
  const children = []
  for (const block of blocks) {
    if (block.kind === 'heading') {
      const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4]
      children.push(new Paragraph({ heading: levels[(block.level || 1) - 1], children: [new TextRun(block.text || '')] }))
    } else if (block.kind === 'paragraph') {
      children.push(new Paragraph({
        spacing: { after: 180, line: 340 },
        children: inlineRuns(docx, block.text || '')
      }))
    } else if (block.kind === 'bullet') {
      children.push(new Paragraph({
        bullet: { level: 0 }, spacing: { after: 100, line: 320 },
        children: inlineRuns(docx, block.text || '')
      }))
    } else if (block.kind === 'numbered') {
      children.push(new Paragraph({
        numbering: { reference: 'office-numbered', level: 0 }, spacing: { after: 100, line: 320 },
        children: inlineRuns(docx, block.text || '')
      }))
    } else if (block.kind === 'table') {
      const rows = block.rows || []
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, color: theme.tableAlt, size: 4 },
          bottom: { style: BorderStyle.SINGLE, color: theme.tableAlt, size: 4 },
          left: { style: BorderStyle.SINGLE, color: theme.tableAlt, size: 4 },
          right: { style: BorderStyle.SINGLE, color: theme.tableAlt, size: 4 },
          insideHorizontal: { style: BorderStyle.SINGLE, color: theme.tableAlt, size: 3 },
          insideVertical: { style: BorderStyle.SINGLE, color: theme.tableAlt, size: 3 }
        },
        rows: rows.map((cells, index) => new TableRow({
          children: cells.map(cell => new TableCell({
            shading: {
              type: ShadingType.CLEAR,
              fill: index === 0 ? theme.primary : index % 2 === 0 ? theme.tableAlt : theme.surface,
              color: 'auto'
            },
            margins: { top: 100, right: 120, bottom: 100, left: 120 },
            children: [new Paragraph({
              children: index === 0
                ? [new TextRun({ text: cell, bold: true, color: 'FFFFFF', font: face })]
                : inlineRuns(docx, cell)
            })]
          }))
        }))
      }))
      children.push(new Paragraph(''))
    }
  }
  const doc = new Document({
    creator: 'Zhumora',
    description: `Generated with the ${themeName || 'modern_blue'} Office theme`,
    styles: {
      default: {
        document: {
          run: { font: face, size: 22, color: theme.body },
          paragraph: { spacing: { line: 320 } }
        },
        heading1: {
          run: { font: face, size: 36, bold: true, color: theme.primary },
          paragraph: {
            spacing: { before: 280, after: 180 }, keepNext: true,
            border: { bottom: { style: BorderStyle.SINGLE, color: theme.accent, size: 12, space: 6 } }
          }
        },
        heading2: {
          run: { font: face, size: 30, bold: true, color: theme.title },
          paragraph: { spacing: { before: 240, after: 140 }, keepNext: true }
        },
        heading3: {
          run: { font: face, size: 26, bold: true, color: theme.primary },
          paragraph: { spacing: { before: 200, after: 100 }, keepNext: true }
        },
        heading4: {
          run: { font: face, size: 23, bold: true, color: theme.title },
          paragraph: { spacing: { before: 160, after: 80 }, keepNext: true }
        }
      }
    },
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
    sections: [{
      properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
      headers: {
        default: new Header({
          children: [new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, color: theme.accent, size: 8, space: 2 } },
            children: [new TextRun({ text: ' ', size: 4 })]
          })]
        })
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              new TextRun({ text: 'Zhumora  ·  ', color: theme.muted, size: 18, font: face }),
              new TextRun({ children: [PageNumber.CURRENT], color: theme.muted, size: 18, font: face })
            ]
          })]
        })
      },
      children: children.length ? children : [new Paragraph('')]
    }]
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
  subtitle?: string
  bullets?: string[]
  table?: { header?: string[]; rows?: string[][] }
  notes?: string
}

interface OfficeTheme {
  background: string
  surface: string
  primary: string
  accent: string
  title: string
  body: string
  muted: string
  tableAlt: string
}

const OFFICE_THEMES: Record<string, OfficeTheme> = {
  modern_blue: {
    background: 'F7F9FC', surface: 'FFFFFF', primary: '2563EB', accent: '14B8A6',
    title: '172033', body: '344054', muted: '667085', tableAlt: 'EEF4FF'
  },
  dark_tech: {
    background: '0B1020', surface: '151C32', primary: '7C3AED', accent: '22D3EE',
    title: 'F8FAFC', body: 'D0D5DD', muted: '98A2B3', tableAlt: '202A44'
  },
  warm_minimal: {
    background: 'FFF9F2', surface: 'FFFFFF', primary: 'C2410C', accent: 'EAB308',
    title: '3F2D20', body: '5F4635', muted: '8C6F5A', tableAlt: 'FEF0DF'
  },
  forest: {
    background: 'F4F8F5', surface: 'FFFFFF', primary: '166534', accent: '65A30D',
    title: '173A2A', body: '365347', muted: '6B7F75', tableAlt: 'E7F3EA'
  },
  corporate: {
    background: 'F5F7FA', surface: 'FFFFFF', primary: '17365D', accent: '4F81BD',
    title: '17365D', body: '334155', muted: '64748B', tableAlt: 'EAF0F7'
  }
}

function resolveOfficeTheme(name?: string, format = 'office'): OfficeTheme {
  if (!name) return OFFICE_THEMES.modern_blue
  const theme = OFFICE_THEMES[name]
  if (!theme) throw new Error(`Unknown ${format} theme "${name}" (expected: ${Object.keys(OFFICE_THEMES).join(', ')})`)
  // Word pages remain white in the current generator, so use the light-paper
  // variant of dark_tech while keeping its violet/cyan identity.
  if (format === 'docx' && name === 'dark_tech') {
    return {
      ...theme,
      background: 'FFFFFF', surface: 'FFFFFF', title: '1F2937', body: '344054',
      muted: '667085', tableAlt: 'EDE9FE'
    }
  }
  return theme
}

async function writePptxFromSlides(filePath: string, content: string, themeName?: string, fontFace?: string): Promise<void> {
  let slides: PptxSlideSpec[]
  try {
    slides = JSON.parse(content)
  } catch (error) {
    throw new Error(`pptx content must be a JSON array of slides: ${(error as Error).message}`)
  }
  if (!Array.isArray(slides) || !slides.length) throw new Error('pptx content must be a non-empty JSON array of slides')
  const PptxGenJS = (await import('pptxgenjs')).default
  const pres = new PptxGenJS()
  const theme = resolveOfficeTheme(themeName, 'pptx')
  const face = fontFace || 'Microsoft YaHei'
  pres.layout = 'LAYOUT_WIDE'
  pres.author = 'Zhumora'
  pres.subject = 'Generated presentation'
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex++) {
    const spec = slides[slideIndex]
    if (typeof spec !== 'object' || spec === null) throw new Error('each slide must be an object like {title, bullets, table}')
    const slide = pres.addSlide()
    slide.background = { color: theme.background }
    slide.addShape(pres.ShapeType.rect, {
      x: 0, y: 0, w: 0.16, h: 7.5,
      line: { color: theme.primary, transparency: 100 },
      fill: { color: theme.primary }
    })
    slide.addShape(pres.ShapeType.rect, {
      x: 0.48, y: 0.43, w: 0.08, h: 0.48,
      line: { color: theme.accent, transparency: 100 },
      fill: { color: theme.accent }
    })
    let cursorY = 0.55
    if (spec.title) {
      slide.addText(String(spec.title), {
        x: 0.72, y: 0.32, w: 11.7, h: 0.72,
        fontFace: face, fontSize: 28, bold: true, color: theme.title,
        margin: 0, breakLine: false, fit: 'shrink'
      })
      cursorY = 1.35
    }
    if (spec.subtitle) {
      slide.addText(String(spec.subtitle), {
        x: 0.72, y: 1.02, w: 11.4, h: 0.4,
        fontFace: face, fontSize: 13, color: theme.muted, margin: 0, fit: 'shrink'
      })
      cursorY = 1.62
    }
    if (spec.bullets?.length) {
      const bulletHeight = Math.min(4.9, Math.max(1.2, spec.bullets.length * 0.52 + 0.35))
      slide.addShape(pres.ShapeType.roundRect, {
        x: 0.62, y: cursorY - 0.12, w: 12.05, h: bulletHeight,
        rectRadius: 0.06,
        line: { color: theme.surface, transparency: 100 },
        fill: { color: theme.surface, transparency: theme.background === theme.surface ? 100 : 0 },
        shadow: { type: 'outer', color: '000000', opacity: 0.12, blur: 1, angle: 45, offset: 1 }
      })
      slide.addText(
        spec.bullets.map(b => ({
          text: String(b),
          options: { bullet: true, breakLine: true, paraSpaceAfter: 11 }
        })),
        {
          x: 0.92, y: cursorY + 0.08, w: 11.35, h: bulletHeight - 0.3,
          fontFace: face, fontSize: 17, color: theme.body,
          margin: 0.08, breakLine: false, fit: 'shrink', valign: 'middle'
        }
      )
      cursorY += bulletHeight + 0.22
    }
    if (spec.table) {
      const header = (spec.table.header || []).map(String)
      const rows = (spec.table.rows || []).map(r => (r || []).map(String))
      const all = [
        ...(header.length ? [header.map(text => ({
          text,
          options: { bold: true, color: 'FFFFFF', fill: { color: theme.primary }, align: 'center' }
        }))] : []),
        ...rows.map((row, rowIndex) => row.map(text => ({
          text,
          options: {
            color: theme.body,
            fill: { color: rowIndex % 2 === 0 ? theme.surface : theme.tableAlt }
          }
        })))
      ]
      if (all.length) {
        slide.addTable(all as never, {
          x: 0.72, y: Math.min(cursorY, 5.25), w: 11.7,
          fontFace: face, fontSize: 12, color: theme.body,
          border: { pt: 0.6, color: theme.tableAlt },
          margin: 0.08, rowH: 0.4, autoFit: false,
          valign: 'middle', breakLine: false
        })
      }
    }
    slide.addText(`${slideIndex + 1} / ${slides.length}`, {
      x: 11.55, y: 7.08, w: 0.85, h: 0.2,
      fontFace: face, fontSize: 9, color: theme.muted, align: 'right', margin: 0
    })
    if (spec.notes) slide.addNotes(String(spec.notes))
  }
  await pres.writeFile({ fileName: filePath })
}

// ---------- pdf：文本 → pdf（中文用系统字体） ----------

const CJK_CHAR = /[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255
  ]
}

function wrapPdfText(font: { widthOfTextAtSize(text: string, size: number): number }, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const char of text || ' ') {
    if (char === '\n') {
      lines.push(current || ' ')
      current = ''
      continue
    }
    const candidate = current + char
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current.trimEnd())
      current = char.trimStart()
    } else {
      current = candidate
    }
  }
  if (current || !lines.length) lines.push(current || ' ')
  return lines
}

async function writePdfFromText(filePath: string, text: string, fontQuery?: string, themeName?: string): Promise<void> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const pdfDoc = await PDFDocument.create()
  const theme = resolveOfficeTheme(themeName, 'pdf')
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
  const contentWidth = pageWidth - margin * 2
  const color = (hex: string) => rgb(...hexToRgb(hex))
  let page = pdfDoc.addPage([pageWidth, pageHeight])
  let y = pageHeight - 78

  const decoratePage = () => {
    page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: color(theme.background) })
    page.drawRectangle({ x: 0, y: pageHeight - 16, width: pageWidth, height: 16, color: color(theme.primary) })
    page.drawRectangle({ x: margin, y: pageHeight - 42, width: 54, height: 4, color: color(theme.accent) })
  }
  decoratePage()

  const nextPage = () => {
    page = pdfDoc.addPage([pageWidth, pageHeight])
    y = pageHeight - 78
    decoratePage()
  }
  const ensureSpace = (height: number) => {
    if (y - height < 62) nextPage()
  }
  const drawWrapped = (value: string, size: number, textColor: string, indent = 0, lineHeight = size * 1.55) => {
    const lines = wrapPdfText(font, value, size, contentWidth - indent)
    ensureSpace(lines.length * lineHeight + 6)
    for (const line of lines) {
      page.drawText(line || ' ', { x: margin + indent, y, size, font, color: color(textColor) })
      y -= lineHeight
    }
    y -= 6
  }

  const blocks = parseMarkdownBlocks(text)
  for (const block of blocks) {
    if (block.kind === 'heading') {
      const level = block.level || 1
      const size = level === 1 ? 24 : level === 2 ? 18 : level === 3 ? 15 : 13
      ensureSpace(size * 2.2)
      drawWrapped(block.text || '', size, level === 1 ? theme.primary : theme.title, 0, size * 1.35)
      if (level === 1) {
        page.drawLine({
          start: { x: margin, y: y + 2 }, end: { x: margin + contentWidth, y: y + 2 },
          thickness: 1.4, color: color(theme.accent)
        })
        y -= 12
      }
    } else if (block.kind === 'paragraph') {
      drawWrapped(block.text || '', 11, theme.body)
    } else if (block.kind === 'bullet' || block.kind === 'numbered') {
      drawWrapped(`${block.kind === 'bullet' ? '–' : '•'}  ${block.text || ''}`, 11, theme.body, 14)
    } else if (block.kind === 'table') {
      const rows = block.rows || []
      if (!rows.length) continue
      const columns = Math.max(...rows.map(row => row.length), 1)
      const cellWidth = contentWidth / columns
      const rowHeight = 28
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        ensureSpace(rowHeight)
        const row = rows[rowIndex]
        const fill = rowIndex === 0 ? theme.primary : rowIndex % 2 === 0 ? theme.tableAlt : theme.surface
        page.drawRectangle({ x: margin, y: y - rowHeight + 7, width: contentWidth, height: rowHeight, color: color(fill) })
        for (let columnIndex = 0; columnIndex < columns; columnIndex++) {
          const raw = String(row[columnIndex] ?? '')
          const line = wrapPdfText(font, raw, 9.5, cellWidth - 12)[0] || ''
          page.drawText(line, {
            x: margin + columnIndex * cellWidth + 6, y: y - 11,
            size: 9.5, font, color: color(rowIndex === 0 ? 'FFFFFF' : theme.body)
          })
          page.drawLine({
            start: { x: margin + columnIndex * cellWidth, y: y - rowHeight + 7 },
            end: { x: margin + columnIndex * cellWidth, y: y + 7 },
            thickness: 0.4, color: color(theme.tableAlt)
          })
        }
        y -= rowHeight
      }
      y -= 10
    }
  }

  const pages = pdfDoc.getPages()
  pages.forEach((currentPage, index) => {
    const footer = `${index + 1} / ${pages.length}`
    currentPage.drawText('Zhumora', { x: margin, y: 30, size: 8.5, font, color: color(theme.muted) })
    currentPage.drawText(footer, {
      x: pageWidth - margin - font.widthOfTextAtSize(footer, 8.5), y: 30,
      size: 8.5, font, color: color(theme.muted)
    })
  })
  if (!blocks.length) {
    page.drawText(' ', { x: margin, y, size: 11, font, color: color(theme.body) })
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
  theme?: string
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
    return createOfficeFile(filePath, format, args.content, args.font, args.theme)
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
