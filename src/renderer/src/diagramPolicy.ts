import { normalizeSvgTag } from '../../shared/diagram.ts'

export const MAX_MERMAID_SOURCE_LENGTH = 50_000

export type MermaidSourceValidation = 'empty' | 'too-large' | null

export function validateMermaidSource(source: string): MermaidSourceValidation {
  if (!source.trim()) return 'empty'
  if (source.length > MAX_MERMAID_SOURCE_LENGTH) return 'too-large'
  return null
}

/** Preserve Mermaid's internal SVG markers while rejecting remote/data CSS resources. */
export function containsExternalCssReference(value: string): boolean {
  const matches = value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)
  for (const match of matches) {
    if (!match[2].trim().startsWith('#')) return true
  }
  return false
}

export type FencedCodeBlock = {
  lang: string
  source: string
  done: boolean
  /** 打开围栏行号（0 起） */
  startLine: number
  /** 闭合围栏行号（0 起）；未闭合块为 -1 */
  endLine: number
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/

/**
 * 扫描 Markdown 文本中所有 fenced code block（CommonMark 子集，与 react-markdown 行为一致）：
 * - 只识别 3+ 个 ` 或 ~ 的围栏；打开行可带 info string，闭合行必须是同字符、
 *   长度不小于打开围栏的纯围栏（无 info string）。
 * - `done`：该块在文本末尾之前已闭合。流式输出中未闭合的 mermaid 块仍是半截语法，
 *   不能直接交给 Mermaid 反复解析 —— 渲染层据此决定"立即出图"还是"暂按源码展示"。
 * - 围栏内出现的更短/异字符围栏行只是普通代码内容，不参与闭合判断。
 */
export function extractFencedCodeBlocks(text: string): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = []
  if (!text) return blocks
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const open = FENCE_RE.exec(lines[i])
    if (!open) { i++; continue }
    const fenceChar = open[1][0]
    const fenceLen = open[1].length
    const lang = (open[2].trim().split(/\s+/)[0] || '').toLowerCase()
    const start = i + 1
    let close = -1
    for (let j = start; j < lines.length; j++) {
      const candidate = FENCE_RE.exec(lines[j])
      if (candidate && candidate[1][0] === fenceChar && candidate[1].length >= fenceLen && candidate[2].trim() === '') {
        close = j
        break
      }
    }
    const done = close >= 0
    const end = done ? close : lines.length
    blocks.push({ lang, source: lines.slice(start, end).join('\n'), done, startLine: i, endLine: close })
    i = end + 1
    if (!done) break
  }
  return blocks
}

/** 与 extractFencedCodeBlocks 相同，但只保留 language === 'mermaid' 的块。 */
export function extractMermaidBlocks(text: string): FencedCodeBlock[] {
  return extractFencedCodeBlocks(text).filter(block => block.lang === 'mermaid')
}

export type MermaidSegment =
  | { type: 'markdown'; key: string; content: string }
  | { type: 'mermaid'; key: string; source: string }

/**
 * 把消息内容切成"普通 Markdown 片段 + mermaid 块"的有序节点（纯函数，可单测）。
 *
 * 只按已闭合的 mermaid fence 切分：
 * - 已闭合的 mermaid 块切出为 mermaid 节点 → 流式输出中该块一闭合就立即出图，不等整条消息完成；
 * - 末尾未闭合的 mermaid 块（半截语法）连同其后的文字整段交给 Markdown 解析器，
 *   remark 会把它按普通代码块展示源码；闭合围栏到达后下一帧自动切出为图表。
 * - 切分边界都落在块级结构上（围栏行独占一行），片段内部不残留半截围栏，
 *   因此每段都可独立解析，渲染结果与整段解析一致。
 */
export function splitMermaidSegments(content: string, enableDiagrams: boolean): MermaidSegment[] {
  if (!enableDiagrams || !content) {
    return content ? [{ type: 'markdown', key: 'm-0', content }] : []
  }
  const blocks = extractFencedCodeBlocks(content).filter(block => block.lang === 'mermaid')
  if (blocks.length === 0) return [{ type: 'markdown', key: 'm-0', content }]

  const lines = content.split('\n')
  // lineOffsets[i] = lines[i] 在 content 中的起始偏移；末位哨兵越过文本末尾
  const lineOffsets: number[] = [0]
  for (let i = 0; i < lines.length; i++) lineOffsets.push(lineOffsets[i] + lines[i].length + 1)

  const segments: MermaidSegment[] = []
  const pushMd = (start: number, end: number) => {
    if (end > start) segments.push({ type: 'markdown', key: `m-${segments.length}`, content: content.slice(start, Math.min(end, content.length)) })
  }
  let cursor = 0
  for (const block of blocks) {
    if (!block.done) {
      // 未闭合块必然是最后一个：剩余文本（含半截围栏）整段按 Markdown 源码展示
      pushMd(cursor, content.length)
      return segments
    }
    // 围栏前的文字；source 直接取 extractFencedCodeBlocks 的干净结果（无尾随换行）
    pushMd(cursor, lineOffsets[block.startLine])
    segments.push({ type: 'mermaid', key: `d-${segments.length}`, source: block.source })
    // 跳过闭合围栏行本身：它属于已消费的块，留在片段里会反过来打开新的代码块
    cursor = lineOffsets[block.endLine + 1]
  }
  pushMd(cursor, content.length)
  return segments
}

/**
 * 把 SVG 光栅化为 PNG/JPEG 数据 URL。
 * 光栅化前先规范化根 tag（补 xmlns 与固有尺寸，否则 <img>/canvas 无法加载）；
 * 画布按 viewBox 尺寸的 2 倍绘制，输出更清晰；背景在光栅化时填入，不依赖 SVG 自身。
 */
export function encodeCanvasImage(svg: string, mimeType: 'image/png' | 'image/jpeg', background: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const normalized = normalizeSvgTag(svg)
    if (!normalized) {
      reject(new Error('SVG root element not found for rasterization.'))
      return
    }
    const viewBox = /viewBox="([^"]+)"/.exec(normalized.normalized)?.[1]
    const parts = viewBox?.split(/\s+/)
    const vw = Number(parts?.[2])
    const vh = Number(parts?.[3])
    if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) {
      reject(new Error('SVG has no usable viewBox for rasterization.'))
      return
    }
    const scale = 2
    const canvas = new OffscreenCanvas(vw * scale, vh * scale)
    const context = canvas.getContext('2d')
    if (!context) {
      reject(new Error('Canvas 2D context unavailable.'))
      return
    }
    const image = new Image()
    const url = URL.createObjectURL(new Blob([normalized.normalized], { type: 'image/svg+xml' }))
    image.onload = () => {
      URL.revokeObjectURL(url)
      context.fillStyle = background
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      canvas.convertToBlob({ type: mimeType, quality: 0.92 })
        .then(blob => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error('Failed to encode raster image.'))
          reader.readAsDataURL(blob)
        })
        .catch(reject)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('SVG rasterization failed.'))
    }
    image.src = url
  })
}
