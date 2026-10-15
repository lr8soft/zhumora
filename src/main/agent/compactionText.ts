/** Bounded excerpts retain beginnings/endings; only the LLM view changes. */
export function compactText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const notice = `\n[Context preview: middle omitted from ${text.length} characters; original content is unchanged.]\n`
  const room = Math.max(0, maxChars - notice.length)
  let head = Math.ceil(room / 2)
  let tail = Math.floor(room / 2)
  if (/[\uD800-\uDBFF]/.test(text[head - 1] || '')) head--
  if (/[\uDC00-\uDFFF]/.test(text[text.length - tail] || '')) tail--
  return text.slice(0, head) + notice + (tail > 0 ? text.slice(-tail) : '')
}
