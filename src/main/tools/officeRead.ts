import { promises as fs } from 'node:fs'
import type { OfficeContentNode, OfficeParserAST } from 'officeparser'
import { officeInteger, officeTextPage, validateOfficeTextPage, type OfficeTextPageArgs } from './officeReadPage.ts'

export type OfficeReadFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf'
export interface OfficeReadArgs extends OfficeTextPageArgs {
  start_page?: number
  end_page?: number
  start_slide?: number
  end_slide?: number
  sheet?: string
  range?: string
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Office operation aborted')
}

function validateScope(args: OfficeReadArgs, format: OfficeReadFormat): void {
  validateOfficeTextPage(args)
  for (const key of ['start_page', 'end_page', 'start_slide', 'end_slide'] as const) {
    if (args[key] !== undefined) {
      if (format !== (key.endsWith('page') ? 'pdf' : 'pptx')) throw new Error(`${key} is not supported for ${format}`)
      officeInteger(args[key], key, 1)
    }
  }
  if (args.sheet !== undefined && (format !== 'xlsx' || typeof args.sheet !== 'string' || !args.sheet.trim())) {
    throw new Error('sheet must be a non-empty sheet name for xlsx reads')
  }
  if (args.range !== undefined && (format !== 'xlsx' || typeof args.range !== 'string')) throw new Error('range is only supported for xlsx reads')
  if (args.range !== undefined) parseRange(args.range)
}

function scopeRange(startValue: unknown, endValue: unknown, total: number, kind: string, maximum = total): [number, number] {
  const start = officeInteger(startValue, `start_${kind}`, 1)
  const end = officeInteger(endValue, `end_${kind}`, Math.min(total, start + maximum - 1))
  if (start > total || end > total || end < start) throw new Error(`Invalid ${kind} range ${start}-${end}; total=${total}`)
  if (end - start + 1 > maximum) throw new Error(`Read at most ${maximum} ${kind}s per scope; use start_${kind}/end_${kind}`)
  return [start, end]
}

async function markdown(ast: OfficeParserAST, content: OfficeContentNode[], signal?: AbortSignal): Promise<string> {
  const { OfficeGenerator } = await import('officeparser')
  const { value } = await OfficeGenerator.generate({ ...ast, content }, 'md', { renderMetadata: false, abortSignal: signal })
  return String(value ?? '').trim()
}

async function readPresentation(ast: OfficeParserAST, args: OfficeReadArgs, signal?: AbortSignal) {
  const slides = ast.content.filter(node => node.type === 'slide')
  if (!slides.length) return { text: '', scope: 'slides=0; total_slides=0' }
  const [start, end] = scopeRange(args.start_slide, args.end_slide, slides.length, 'slide')
  const output: string[] = []
  for (let i = start - 1; i < end; i++) {
    assertActive(signal)
    const body = await markdown(ast, slides[i].children ?? [], signal)
    output.push(`## Slide ${i + 1}\n\n${body}`)
  }
  return { text: output.join('\n\n'), scope: `slides=${start}-${end}; total_slides=${slides.length}${end < slides.length ? `; next_slide=${end + 1}` : ''}` }
}

type CellRange = { firstRow: number; lastRow: number; firstCol: number; lastCol: number }
function columnNumber(value: string): number {
  let n = 0
  for (const ch of value.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64
  return n
}

function columnName(value: number): string {
  let text = ''
  for (let n = value; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + (n - 1) % 26) + text
  return text
}

function parseRange(value: string): CellRange {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)(?::\$?([A-Za-z]{1,3})\$?([1-9]\d*))?$/.exec(value)
  if (!match) throw new Error('range must be an A1 cell or rectangle, for example B20:D80')
  const range = { firstCol: columnNumber(match[1]), firstRow: Number(match[2]), lastCol: columnNumber(match[3] ?? match[1]), lastRow: Number(match[4] ?? match[2]) }
  if (range.lastCol > 16384 || range.lastRow > 1048576 || range.lastCol < range.firstCol || range.lastRow < range.firstRow) {
    throw new Error('range must be ordered and within Excel worksheet bounds')
  }
  return range
}

function rangeName(range: CellRange): string {
  return `${columnName(range.firstCol)}${range.firstRow}:${columnName(range.lastCol)}${range.lastRow}`
}

function csvValue(value: string): string {
  return /[,"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function readSheet(node: OfficeContentNode, selection?: string): string {
  const cells = (node.children ?? []).flatMap(row => (row.children ?? []).filter(cell => cell.type === 'cell'))
  const rows = new Map<number, Map<number, string>>()
  let lastRow = 0
  let lastCol = 0
  for (const cell of cells) {
    if (cell.type !== 'cell') continue
    const row = (cell.metadata?.row ?? 0) + 1
    const col = (cell.metadata?.col ?? 0) + 1
    lastRow = Math.max(lastRow, row)
    lastCol = Math.max(lastCol, col)
    if (!rows.has(row)) rows.set(row, new Map())
    rows.get(row)!.set(col, cell.text ?? '')
  }
  const name = node.type === 'sheet' ? node.metadata?.sheetName ?? 'Sheet' : 'Sheet'
  if (!lastRow) return `# Sheet: ${name}\n# used_range: empty`
  const full = { firstRow: 1, firstCol: 1, lastRow, lastCol }
  const selected = selection ? parseRange(selection) : full
  // Sparse worksheets may span Excel's entire grid. Avoid materializing empty
  // rectangles; row labels preserve coordinates while only occupied rows render.
  const output = [`# Sheet: ${name}`, `# used_range: ${rangeName(full)}; selected_range: ${rangeName(selected)}`]
  for (const [row, values] of [...rows].sort(([a], [b]) => a - b)) {
    if (row < selected.firstRow || row > selected.lastRow) continue
    const populated = [...values.keys()].some(col => col >= selected.firstCol && col <= selected.lastCol)
    if (!populated) continue
    output.push(`# Row: ${row}`)
    const text: string[] = []
    for (let col = selected.firstCol; col <= Math.min(selected.lastCol, lastCol); col++) text.push(csvValue(values.get(col) ?? ''))
    output.push(text.join(','))
  }
  return output.join('\n')
}

function readWorkbook(ast: OfficeParserAST, args: OfficeReadArgs, signal?: AbortSignal) {
  const sheets = ast.content.filter(node => node.type === 'sheet')
  const selected = args.sheet === undefined ? sheets : sheets.filter(node => node.metadata?.sheetName === args.sheet)
  if (!selected.length && args.sheet !== undefined) throw new Error(`Sheet not found: ${args.sheet}`)
  const text = selected.map(node => { assertActive(signal); return readSheet(node, args.range) }).join('\n\n')
  return { text, scope: `sheets=${JSON.stringify(selected.map(node => node.metadata?.sheetName))}; total_sheets=${sheets.length}; sparse_rows=true; range=${args.range ?? 'used'}` }
}

async function readPdf(filePath: string, args: OfficeReadArgs, signal?: AbortSignal) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  assertActive(signal)
  const data = new Uint8Array(await fs.readFile(filePath, { signal }))
  const task = pdfjs.getDocument({ data })
  const cancel = () => { void task.destroy().catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const doc = await task.promise
    assertActive(signal)
    const [start, end] = scopeRange(args.start_page, args.end_page, doc.numPages, 'page', 200)
    const pages: string[] = []
    for (let i = start; i <= end; i++) {
      assertActive(signal)
      const page = await doc.getPage(i)
      const { items } = await page.getTextContent()
      let text = ''
      let lastY: number | null = null
      for (const item of items) {
        if (!('str' in item) || typeof item.str !== 'string') continue
        const y = item.transform?.[5]
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) text += '\n'
        else if (text && !text.endsWith('\n') && !text.endsWith(' ')) text += ' '
        text += item.str
        if (y !== undefined) lastY = y
      }
      pages.push(`--- page ${i} ---\n${text.trim()}`)
      page.cleanup()
    }
    return { text: pages.join('\n\n'), scope: `pages=${start}-${end}; total_pages=${doc.numPages}${end < doc.numPages ? `; next_page=${end + 1}` : ''}` }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await task.destroy()
    assertActive(signal)
  }
}

export async function readOfficeFile(filePath: string, format: OfficeReadFormat, args: OfficeReadArgs, signal?: AbortSignal): Promise<string> {
  validateScope(args, format)
  assertActive(signal)
  await fs.access(filePath)
  if (format === 'pdf') {
    const { text, scope } = await readPdf(filePath, args, signal)
    return officeTextPage(text, args, scope)
  }
  const { OfficeParser } = await import('officeparser')
  const ast = await OfficeParser.parseOffice(filePath, { abortSignal: signal })
  assertActive(signal)
  const document = format === 'pptx' ? await readPresentation(ast, args, signal)
    : format === 'xlsx' ? readWorkbook(ast, args, signal)
      : { text: await markdown(ast, ast.content, signal), scope: 'document=all; cursor_unit=converted_markdown_line' }
  assertActive(signal)
  return officeTextPage(document.text, args, document.scope)
}
