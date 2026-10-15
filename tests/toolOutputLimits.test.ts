import assert from 'node:assert/strict'
import { BoundedToolOutput, browserOutputLength, browserTextPreview, limitToolOutput, MAX_TOOL_OUTPUT_CHARS, MAX_COMMAND_OUTPUT_LINES } from '../src/main/tools/outputLimits.ts'

const hint = 'Narrow the query.'
for (const text of ['', 'one line', 'one\ntwo\n', 'one\r\ntwo\r\n', '中文 😀\nlast']) {
  const output = new BoundedToolOutput(hint)
  for (const part of text) output.append(part)
  assert.equal(output.snapshot().text, text, 'small outputs preserve exact content across chunk boundaries')
}
const output = new BoundedToolOutput(hint, MAX_COMMAND_OUTPUT_LINES)
for (let line = 0; line < 50_000; line++) output.append(`line-${line}\n`)
const result = output.snapshot()
assert.match(result.text, /line-0\n/); assert.match(result.text, /line-49999/)
assert.doesNotMatch(result.text, /line-25000/)
assert.match(result.text, /Output truncated/); assert.match(result.text, /Narrow the query/)
assert.equal(result.totalLines, 50_000)
assert.ok(result.text.split('\n').length <= MAX_COMMAND_OUTPUT_LINES)
assert.ok(result.text.length <= MAX_TOOL_OUTPUT_CHARS)
assert.ok(result.retainedChars <= MAX_TOOL_OUTPUT_CHARS)
const giant = limitToolOutput(`FIRST${'x'.repeat(2_000_000)}LAST`, hint)
assert.match(giant, /^FIRST/); assert.match(giant, /LAST/); assert.match(giant, /line truncated/)
assert.ok(giant.length < 5_000, 'one giant line cannot bypass the width cap')
const unicode = limitToolOutput(`START\n${'😀汉字'.repeat(100_000)}\nEND`, hint)
assert.ok(unicode.isWellFormed()); assert.match(unicode, /START/); assert.match(unicode, /END/)
assert.ok(unicode.length <= MAX_TOOL_OUTPUT_CHARS)
assert.equal(browserOutputLength(undefined), 5000)
assert.equal(browserOutputLength(100), 100)
assert.equal(browserOutputLength(1_000_000_000), MAX_TOOL_OUTPUT_CHARS)
for (const invalid of [0, -1, NaN, Infinity, 1.2, '100', null]) assert.throws(() => browserOutputLength(invalid))
const page = browserTextPreview('HTML\n'.repeat(100_000), 1_000_000_000)
assert.ok(page.length <= MAX_TOOL_OUTPUT_CHARS); assert.match(page, /narrower selector/)
console.log('Tool output limits: streaming bounds, head/tail, line/width caps, Unicode, notices and browser hard ceiling passed')
