/** 规范化 SVG 根 tag：补 xmlns（作为图片加载时必需）与 viewBox 派生的 width/height（canvas 固有尺寸）。 */
export function normalizeSvgTag(svg: string): { tag: string; normalized: string } | null {
  const tagMatch = /<svg\b[^>]*>/.exec(svg)
  if (!tagMatch) return null
  const tag = tagMatch[0]
  let next = tag
  if (!/\bxmlns=/.test(tag)) next = next.replace(/<svg\b/, `<svg xmlns="http://www.w3.org/2000/svg"`)
  const viewBox = /viewBox="([^"]+)"/.exec(tag)?.[1]
  const parts = viewBox?.split(/\s+/)
  const w = parts?.[2]
  const h = parts?.[3]
  if (w && h && Number(w) > 0 && Number(h) > 0 && !/\bwidth=/.test(tag)) {
    next = next.replace(/<svg\b/, `<svg width="${w}" height="${h}"`)
  }
  return { tag, normalized: next }
}

/**
 * 转义源码以便安全放入 XML 注释体：把任意连续 "-"（≥2 个）整体拆开（如 "-->" 变 "   >"，
 * "---" 变 "   "），确保注释体不含任何 "--"。单破折号（如 "a - b"）保持不变。
 */
export function escapeXmlCommentBody(source: string): string {
  return source.replace(/-{2,}/g, run => run.split('-').join(' '))
}

/**
 * 构造可独立打开的 SVG 文件内容：源码放进文件头 XML 注释，并给 SVG 补上与主题一致的背景矩形。
 *
 * XML 注释体禁止出现任何 "--"（不只是 "-->"），而 Mermaid 箭头语法到处是 "--"，
 * 因此注释体先经 escapeXmlCommentBody 转义。注释仅供人读参考，真值在聊天消息里。
 */
export function buildStandaloneSvg(svg: string, source: string, background: string): string {
  const header = source
    ? `<!--\n${escapeXmlCommentBody(source)}\n-->\n`
    : ''
  const normalized = normalizeSvgTag(svg)
  if (!normalized) return header + svg
  const { tag, normalized: next } = normalized
  const viewBox = /viewBox="([^"]+)"/.exec(tag)?.[1]
  const parts = viewBox?.split(/\s+/)
  // 自闭合 <svg .../> 无法插入子元素，跳过背景矩形（真实 Mermaid 输出总有子元素）
  const rect = /\/>$/.test(tag) ? '' : `<rect width="${parts?.[2] || '100%'}" height="${parts?.[3] || '100%'}" fill="${background}"/>`
  return header + svg.replace(tag, `${next}${rect}`)
}

/** 校验待落盘的独立 SVG 内容：必须是 SVG 根元素，且文件头注释体不得包含 "--"（XML 非法，浏览器会解析失败）。 */
export function validateStandaloneSvg(content: string): boolean {
  if (!content) return false
  const start = content.indexOf('<svg')
  if (start < 0 || start > 512) return false
  const comment = /<!--([\s\S]*?)-->/.exec(content.slice(0, start))
  return comment ? !comment[1].includes('--') : true
}
