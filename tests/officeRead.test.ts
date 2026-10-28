import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { executeOffice } from '../src/main/tools/office.ts'
import { officeTools } from '../src/main/tools/officeTool.ts'
import { OFFICE_READ_BYTES, officeTextPage, type OfficeTextPageArgs } from '../src/main/tools/officeReadPage.ts'
import { readStableOfficeScope } from '../src/main/tools/officeReadSource.ts'
import { ToolOutputStore } from '../src/main/tools/toolOutputStore.ts'
import { normalizeToolOutput } from '../src/main/tools/registry.ts'

const workspace = path.resolve(import.meta.dirname, '..')
const root = await fs.mkdtemp(path.join(workspace, '.test-office-read-'))
const store = new ToolOutputStore(path.join(root, 'snapshots'))
type Cursor = { offset: number; char_offset: number; source_revision?: string }
function pageContent(output: string): string {
  return output.slice(output.indexOf('\n') + 1, output.lastIndexOf('\n'))
}
function nextCursor(output: string): Cursor | undefined {
  const match = /Repeat the same scope with (\{[^\n]+?\}); char_offset/.exec(output)
  return match ? JSON.parse(match[1]) as Cursor : undefined
}
async function readAll(filePath: string): Promise<string> {
  let cursor: OfficeTextPageArgs = {}
  let result = ''
  for (let i = 0; i < 30; i++) {
    const text = await executeOffice({ action: 'read', file_path: filePath, ...cursor }, root)
    assert.ok(Buffer.byteLength(text) <= OFFICE_READ_BYTES)
    result += pageContent(text)
    const next = nextCursor(text)
    if (!next) return result
    assert.notDeepEqual(next, cursor, 'cursor must advance')
    cursor = next
  }
  throw new Error('Office continuation did not finish')
}

try {
  const line = '中😀'.repeat(25000) + 'LAST-LONG-LINE'
  let cursor: Cursor = { offset: 1, char_offset: 0 }
  let restored = ''
  for (let i = 0; i < 20; i++) {
    const output = officeTextPage(line, cursor, 'test')
    assert.ok(Buffer.byteLength(output) <= OFFICE_READ_BYTES)
    restored += pageContent(output)
    const next = nextCursor(output)
    if (!next) break
    assert.equal(next.offset, 1)
    assert.ok(next.char_offset > cursor.char_offset)
    cursor = next
  }
  assert.equal(restored, line, 'all Unicode code units survive byte-budget continuation')
  assert.equal(pageContent(officeTextPage('first\nsecond\nthird', { offset: 3 }, 'test')), 'third')
  assert.deepEqual(nextCursor(officeTextPage('first\nsecond\nthird', { limit: 1 }, 'test')), { offset: 2, char_offset: 0 })
  for (const args of [{ offset: 0 }, { limit: 2001 }, { char_offset: -1 }, { char_offset: 1 }]) {
    assert.throws(() => officeTextPage('😀text', args, 'test'))
  }

  const docxPath = path.join(root, 'large.docx')
  const artifactLine = '大'.repeat(80000) + 'LAST-LONG-LINE'
  await executeOffice({ action: 'create', file_path: docxPath, content: artifactLine }, root)
  assert.match(await readAll(docxPath), /LAST-LONG-LINE/)
  const docCursor = nextCursor(await executeOffice({ action: 'read', file_path: docxPath }, root))!
  const short = await executeOffice({ action: 'read', file_path: docxPath, ...docCursor }, root)
  assert.match(short, new RegExp(`char_offset=${docCursor.char_offset}`))
  assert.doesNotMatch(pageContent(short), /line truncated/)

  const workbookPath = path.join(root, 'ranges.xlsx')
  await executeOffice({ action: 'create', file_path: workbookPath, content: '# Sheet: First\nA,B\n1,2\n\n# Sheet: Later\nX,Y\n3,4' }, root)
  await executeOffice({ action: 'edit', file_path: workbookPath, ops: [
    { sheet: 'Later', cell: 'C3000', value: 'DEEP-CELL' },
    { sheet: 'Later', cell: 'D3000', value: 'OUTSIDE-CELL' },
    { sheet: 'Later', cell: 'C3001', value: artifactLine }
  ] }, root)
  const range = await executeOffice({ action: 'read', file_path: workbookPath, sheet: 'Later', range: 'C3000:C3000' }, root)
  assert.match(range, /DEEP-CELL/)
  assert.match(range, /used_range: A1:D3001/)
  assert.match(range, /# Row: 3000/)
  assert.doesNotMatch(range, /OUTSIDE-CELL/)
  assert.doesNotMatch(range, /# Sheet: First/)
  assert.match(await readAll(workbookPath), /LAST-LONG-LINE/)
  await assert.rejects(() => executeOffice({ action: 'read', file_path: workbookPath, range: 'C3:A1' }, root), /range must be ordered/)
  await assert.rejects(() => executeOffice({ action: 'read', file_path: workbookPath, range: 'XFE1' }, root), /worksheet bounds/)
  await assert.rejects(() => executeOffice({ action: 'read', file_path: workbookPath, sheet: 'Missing' }, root), /Sheet not found/)

  const deckPath = path.join(root, 'slides.pptx')
  await executeOffice({ action: 'create', file_path: deckPath, content: JSON.stringify([
    { title: 'SLIDE-ONE', bullets: ['start'] },
    { title: 'SLIDE-TWO', bullets: [artifactLine] },
    { title: 'SLIDE-THREE', bullets: ['last'] }
  ]) }, root)
  const lastSlide = await executeOffice({ action: 'read', file_path: deckPath, start_slide: 3, end_slide: 3 }, root)
  assert.match(lastSlide, /## Slide 3/)
  assert.match(lastSlide, /SLIDE-THREE/)
  assert.match(lastSlide, /total_slides=3/)
  assert.doesNotMatch(lastSlide, /SLIDE-ONE/)
  assert.doesNotMatch(lastSlide, /author:|created:|title: "PptxGenJS|\*\*Note:\*\*/,
    'slide reads preserve the original cleanup of document frontmatter and note artifacts')
  assert.match(await readAll(deckPath), /SLIDE-THREE/)
  await assert.rejects(() => executeOffice({ action: 'read', file_path: deckPath, start_slide: 4 }, root), /Invalid slide range/)

  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const pdfPath = path.join(root, 'pages.pdf')
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 205; i++) pdf.addPage().drawText(`PAGE-${i}`, { x: 30, y: 700, font })
  await fs.writeFile(pdfPath, await pdf.save())
  const page201 = await executeOffice({ action: 'read', file_path: pdfPath, start_page: 201, end_page: 201 }, root)
  assert.match(page201, /--- page 201 ---/)
  assert.match(page201, /PAGE-201/)
  assert.match(page201, /total_pages=205/)
  assert.doesNotMatch(page201, /--- page 1 ---/)
  const firstBatch = await executeOffice({ action: 'read', file_path: pdfPath }, root)
  assert.match(firstBatch, /pages=1-200; total_pages=205; next_page=201/)
  const finalBatch = await executeOffice({ action: 'read', file_path: pdfPath, start_page: 201 }, root)
  assert.match(finalBatch, /PAGE-205/)
  await assert.rejects(() => executeOffice({ action: 'read', file_path: pdfPath, start_page: 1, end_page: 201 }, root), /at most 200/)
  for (const start_page of [0, 1.5, 206]) await assert.rejects(() => executeOffice({ action: 'read', file_path: pdfPath, start_page }, root))
  await assert.rejects(() => executeOffice({ action: 'read', file_path: docxPath, start_page: 1 }, root), /not supported for docx/)

  const aborted = new AbortController()
  aborted.abort()
  for (const filePath of [docxPath, workbookPath, deckPath, pdfPath]) {
    await assert.rejects(() => executeOffice({ action: 'read', file_path: filePath }, root, aborted.signal), /aborted/)
  }
  const activeAbort = new AbortController()
  const pendingPdf = executeOffice({ action: 'read', file_path: pdfPath }, root, activeAbort.signal)
  activeAbort.abort()
  await assert.rejects(() => pendingPdf, /aborted|AbortError/i)
  const handler = officeTools.find(tool => tool.name === 'word_document')!.handler
  const result = await handler.execute({ action: 'read', file_path: docxPath, limit: 1 }, { workspacePath: root })
  assert.equal(typeof result, 'object')
  assert.match((result as { content: string }).content, /Repeat the same scope/)

  const context = { workspacePath: root, sessionId: 'office-snapshot', outputStore: store }
  const docSnapshot = normalizeToolOutput(await handler.execute({ action: 'read', file_path: docxPath }, context))
  assert.ok(docSnapshot.outputRef)
  assert.ok(Buffer.byteLength(docSnapshot.content) <= OFFICE_READ_BYTES)
  assert.match(docSnapshot.content, /read_tool_output/)
  const docNext = nextCursor(docSnapshot.content)!
  assert.match(docNext.source_revision!, /^[a-f0-9]{64}$/)
  const originalDocLine = await store.read(context.sessionId, docSnapshot.outputRef.id, {
    offset: docNext.offset, char_offset: artifactLine.length - 500, limit: 1
  })
  assert.match(originalDocLine, /LAST-LONG-LINE/)
  await executeOffice({ action: 'create', file_path: docxPath, content: 'REPLACED-VERSION' }, root)
  assert.match(await store.read(context.sessionId, docSnapshot.outputRef.id, {
    offset: docNext.offset, char_offset: artifactLine.length - 500, limit: 1
  }), /LAST-LONG-LINE/, 'a document edit cannot change an already returned snapshot')
  await assert.rejects(() => executeOffice({ action: 'read', file_path: docxPath, ...docNext }, root), /source_revision changed/)
  await assert.rejects(() => executeOffice({ action: 'read', file_path: docxPath, offset: 2 }, root), /requires source_revision/)

  const pptHandler = officeTools.find(tool => tool.name === 'powerpoint_presentation')!.handler
  const pptSnapshot = normalizeToolOutput(await pptHandler.execute({ action: 'read', file_path: deckPath, start_slide: 2, end_slide: 3 }, context))
  assert.ok(pptSnapshot.outputRef)
  const pptNext = nextCursor(pptSnapshot.content)!
  await executeOffice({ action: 'create', file_path: deckPath, content: JSON.stringify([{ title: 'REPLACED-DECK', bullets: ['changed'] }]) }, root)
  assert.match(await store.read(context.sessionId, pptSnapshot.outputRef.id, { pattern: 'SLIDE-THREE' }), /SLIDE-THREE/)
  await assert.rejects(() => executeOffice({ action: 'read', file_path: deckPath, start_slide: 2, end_slide: 3, ...pptNext }, root), /source_revision changed/)

  const quotaStore = new ToolOutputStore(path.join(root, 'tiny-quota'), { maxResultBytes: 32, maxSessionBytes: 64 })
  try {
    const fallback = normalizeToolOutput(await pptHandler.execute({ action: 'read', file_path: deckPath, limit: 1 }, { ...context, outputStore: quotaStore }))
    assert.equal(fallback.isError, undefined, 'storage exhaustion does not turn a valid Office read into a business failure')
    assert.equal(fallback.outputRef, undefined)
    assert.match(fallback.content, /Storage warning:.*quota/)
    const native = nextCursor(fallback.content)!
    assert.match(await executeOffice({ action: 'read', file_path: deckPath, ...native }, root), /REPLACED-DECK/,
      'the returned versioned cursor remains usable after backup failure')
    await executeOffice({ action: 'create', file_path: deckPath, content: JSON.stringify([{ title: 'ANOTHER-VERSION' }]) }, root)
    await assert.rejects(() => executeOffice({ action: 'read', file_path: deckPath, ...native }, root), /source_revision changed/)
  } finally { await quotaStore.dispose() }

  const changing = path.join(root, 'change-during-conversion.txt')
  await fs.writeFile(changing, 'before')
  await assert.rejects(readStableOfficeScope(changing, undefined, async () => {
    await fs.writeFile(changing, 'after')
    return { text: 'partial old conversion', scope: 'test' }
  }), /source changed during conversion/)
  console.log('office read ranges: passed (Word, Excel, PowerPoint, PDF, UTF-16 continuation, validation, abort)')
} finally {
  await store.dispose()
  assert.equal(path.dirname(path.resolve(root)), workspace)
  assert.match(path.basename(root), /^\.test-office-read-/)
  await fs.rm(root, { recursive: true, force: true })
}
