// PDF 中文字体嵌入辅助：
// 从系统字体文件读出字节，TTC/OTC 集合拆成单个字体，供 pdf-lib 的 embedFont 使用。
//
// 关键结论（本机验证）：
// - TTC 的表偏移是"相对文件起始的绝对偏移"（base=0），不是相对各字体 sfnt 头。
//   重建单字体时，把各表从 buf[off] 拷到 out[off]（同一绝对偏移）即可，目录重建到 0。
// - 拆出的单字体用 { subset: true } 嵌入可大幅减小 PDF；subset 失败时回退全量嵌入。
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { resolveDefaultFont, resolveSystemFont, type SystemFont } from './systemFonts.ts'

const COLLECTION_EXTS = new Set(['.ttc', '.otc'])

/** 从 TTC/OTC 集合拆出每个子字体的单字体字节。非集合返回 null。 */
export function splitFontCollection(buf: Buffer): Buffer[] | null {
  const tag = buf.readUInt32BE(0)
  if (tag !== 0x74746366 /*ttcf*/ && tag !== 0x4f54544f /*OTTO*/ && tag !== 0x6f544330 /*OTC0*/) return null
  const numFonts = buf.readUInt32BE(8)
  const sfntOffsets: number[] = []
  for (let i = 0; i < numFonts; i++) sfntOffsets.push(buf.readUInt32BE(12 + 4 * i))
  return sfntOffsets.map(sfnt => rebuildSingleFont(buf, sfnt))
}

function rebuildSingleFont(buf: Buffer, sfnt: number): Buffer {
  const version = buf.readUInt32BE(sfnt)
  const numTables = buf.readUInt16BE(sfnt + 4)
  const dirSize = 12 + numTables * 16
  let dataEnd = 0
  const tables: { tag: string; cs: number; off: number; len: number }[] = []
  for (let t = 0; t < numTables; t++) {
    const e = sfnt + 12 + t * 16
    const off = buf.readUInt32BE(e + 8)
    const len = buf.readUInt32BE(e + 12)
    tables.push({ tag: buf.toString('ascii', e, e + 4), cs: buf.readUInt32BE(e + 4), off, len })
    dataEnd = Math.max(dataEnd, off + len)
  }
  const out = Buffer.alloc(dirSize + dataEnd)
  out.writeUInt32BE(version, 0)
  out.writeUInt16BE(numTables, 4)
  out.writeUInt16BE(buf.readUInt16BE(sfnt + 6), 6)
  out.writeUInt16BE(buf.readUInt16BE(sfnt + 8), 8)
  out.writeUInt16BE(buf.readUInt16BE(sfnt + 10), 10)
  for (let t = 0; t < numTables; t++) {
    const e = 12 + t * 16
    out.write(tables[t].tag, e, 'ascii')
    out.writeUInt32BE(tables[t].cs, e + 4)
    out.writeUInt32BE(tables[t].off, e + 8)
    out.writeUInt32BE(tables[t].len, e + 12)
    // base=0：表数据在文件中的绝对偏移，原样拷贝
    buf.copy(out, tables[t].off, tables[t].off, tables[t].off + tables[t].len)
  }
  return out
}

/**
 * 读取系统字体并返回可直接喂给 pdf-lib embedFont 的字节。
 * - query 为空时用当前语言默认字体（见 resolveDefaultFont）
 * - TTC/OTC 拆集合后按名称挑子字体（如 "Microsoft YaHei" 优先于 "Microsoft YaHei UI"）
 */
export async function loadEmbeddableFont(query?: string): Promise<{ bytes: Buffer; font: SystemFont; subPostscript?: string }> {
  const font = query ? await resolveSystemFont(query) : await resolveDefaultFont(query)
  const raw = await fs.readFile(font.file)
  const ext = path.extname(font.file).toLowerCase()
  if (!COLLECTION_EXTS.has(ext)) return { bytes: raw, font }

  const subs = splitFontCollection(raw)
  if (!subs || !subs.length) return { bytes: raw, font }
  if (subs.length === 1) return { bytes: subs[0], font }

  // 用 @pdf-lib/fontkit 解析每个子字体的 postscriptName，按请求名挑选
  const { default: pdfFontkit } = await import('@pdf-lib/fontkit')
  const wanted = (query || font.name).toLowerCase().replace(/[\s_]+/g, '')
  const candidates: { bytes: Buffer; ps: string; family: string }[] = []
  for (const s of subs) {
    try {
      const f = await pdfFontkit.create(s)
      candidates.push({ bytes: s, ps: (f.postscriptName || '').toLowerCase(), family: (f.familyName || '').toLowerCase().replace(/[\s_]+/g, '') })
    } catch { /* 跳过无法解析的子字体 */ }
  }
  // 精确/后缀匹配优先，避免选中 "UI" 变体
  const hit = candidates.find(c => c.ps === wanted || c.family === wanted)
    || candidates.find(c => c.ps.startsWith(wanted) && !/ui$/.test(c.ps))
    || candidates.find(c => c.family.startsWith(wanted))
    || candidates[0]
  if (!hit) throw new Error(`Font collection ${font.file} has no usable subfont`)
  return { bytes: hit.bytes, font, subPostscript: hit.ps }
}
