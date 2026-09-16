import assert from 'node:assert/strict'

import {
  containsExternalCssReference,
  isMermaidCodeClass,
  MAX_MERMAID_SOURCE_LENGTH,
  normalizeCodeSource,
  validateMermaidSource
} from '../src/renderer/src/diagramPolicy.ts'

assert.equal(isMermaidCodeClass('language-mermaid'), true)
assert.equal(isMermaidCodeClass('hljs language-mermaid'), true)
assert.equal(isMermaidCodeClass('mermaid'), false, 'only explicit fenced language markers enable diagrams')
assert.equal(isMermaidCodeClass('language-mermaid-extra'), false)
assert.equal(isMermaidCodeClass(undefined), false)

assert.equal(normalizeCodeSource('flowchart LR\n'), 'flowchart LR')
assert.equal(normalizeCodeSource('flowchart LR\n\n'), 'flowchart LR\n')
assert.equal(normalizeCodeSource(null), '')

assert.equal(validateMermaidSource('   \n'), 'empty')
assert.equal(validateMermaidSource('flowchart LR\nA --> B'), null)
assert.equal(validateMermaidSource('x'.repeat(MAX_MERMAID_SOURCE_LENGTH)), null)
assert.equal(validateMermaidSource('x'.repeat(MAX_MERMAID_SOURCE_LENGTH + 1)), 'too-large')

assert.equal(containsExternalCssReference('marker-end: url(#arrowhead)'), false)
assert.equal(containsExternalCssReference('fill: url("#local-gradient")'), false)
assert.equal(containsExternalCssReference('fill: url(https://example.com/pixel.svg)'), true)
assert.equal(containsExternalCssReference("background: url('data:image/svg+xml;base64,abc')"), true)

console.log('diagram policy tests passed')
