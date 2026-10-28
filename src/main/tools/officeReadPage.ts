/** Office cursors address converted text, never a truncated preview. */
export interface OfficeTextPageArgs {
  offset?: number
  limit?: number
  char_offset?: number
}

export const OFFICE_READ_BYTES = 50 * 1024

export function officeInteger(value: unknown, name: string, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  return value as number
}

export function validateOfficeTextPage(args: OfficeTextPageArgs): void {
  officeInteger(args.offset, 'offset', 1)
  const limit = officeInteger(args.limit, 'limit', 2000)
  if (limit > 2000) throw new Error('limit must be <= 2000')
  officeInteger(args.char_offset, 'char_offset', 0, 0)
}

export function officeTextPage(text: string, args: OfficeTextPageArgs, scope: string): string {
  validateOfficeTextPage(args)
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const offset = officeInteger(args.offset, 'offset', 1)
  const limit = officeInteger(args.limit, 'limit', 2000)
  const charOffset = officeInteger(args.char_offset, 'char_offset', 0, 0)
  if (offset > lines.length) throw new Error(`offset ${offset} exceeds converted text length (${lines.length} lines)`)
  const first = lines[offset - 1]
  if (charOffset > first.length || (charOffset > 0 && /[\uDC00-\uDFFF]/.test(first[charOffset] ?? '')
    && /[\uD800-\uDBFF]/.test(first[charOffset - 1]))) throw new Error('char_offset is outside the line or splits a Unicode character')
  const header = `[Office scope: ${scope}; converted_text_lines=${lines.length}; offset=${offset}; char_offset=${charOffset}]\n`
  const budget = OFFICE_READ_BYTES - Buffer.byteLength(header) - 640
  if (budget <= 0) throw new Error('Office scope metadata exceeds output budget')
  let bytes = 0
  let body = ''
  let next: { offset: number; char_offset: number } | undefined
  for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
    const start = i === offset - 1 ? charOffset : 0
    const separator = i === offset - 1 ? '' : '\n'
    if (bytes + separator.length > budget) { next = { offset: i + 1, char_offset: start }; break }
    body += separator
    bytes += separator.length
    let consumed = start
    for (const char of lines[i].slice(start)) {
      const size = Buffer.byteLength(char)
      if (bytes + size > budget) { next = { offset: i + 1, char_offset: consumed }; break }
      body += char
      bytes += size
      consumed += char.length
    }
    if (next) break
    if (i + 1 < lines.length) next = { offset: i + 2, char_offset: 0 }
    // A provisional next-line cursor must not stop this page's remaining lines.
    if (i + 1 < offset - 1 + limit) next = undefined
  }
  const end = next
    ? `[More converted text. Repeat the same scope with ${JSON.stringify(next)}; char_offset counts UTF-16 code units.]`
    : '[End of selected scope.]'
  return `${header}${body}\n${end}`
}
