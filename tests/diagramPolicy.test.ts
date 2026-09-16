import assert from 'node:assert/strict'

import {
  containsExternalCssReference,
  extractFencedCodeBlocks,
  extractMermaidBlocks,
  MAX_MERMAID_SOURCE_LENGTH,
  splitMermaidSegments,
  validateMermaidSource
} from '../src/renderer/src/diagramPolicy.ts'
import { buildStandaloneSvg, escapeXmlCommentBody, validateStandaloneSvg } from '../src/shared/diagram.ts'

assert.equal(validateMermaidSource('   \n'), 'empty')
assert.equal(validateMermaidSource('flowchart LR\nA --> B'), null)
assert.equal(validateMermaidSource('x'.repeat(MAX_MERMAID_SOURCE_LENGTH)), null)
assert.equal(validateMermaidSource('x'.repeat(MAX_MERMAID_SOURCE_LENGTH + 1)), 'too-large')

assert.equal(containsExternalCssReference('marker-end: url(#arrowhead)'), false)
assert.equal(containsExternalCssReference('fill: url("#local-gradient")'), false)
assert.equal(containsExternalCssReference('fill: url(https://example.com/pixel.svg)'), true)
assert.equal(containsExternalCssReference("background: url('data:image/svg+xml;base64,abc')"), true)

// ---------- 围栏扫描 ----------

assert.deepEqual(extractFencedCodeBlocks(''), [])
assert.deepEqual(extractFencedCodeBlocks('no fences here'), [])

const one = 'text\n```mermaid\nflowchart LR\nA --> B\n```\ntail'
const [b1] = extractFencedCodeBlocks(one)
assert.equal(b1.lang, 'mermaid')
assert.equal(b1.source, 'flowchart LR\nA --> B')
assert.equal(b1.done, true)
assert.equal(b1.startLine, 1)
assert.equal(b1.endLine, 4)

// 未闭合围栏（流式输出中的半截块）：done=false，source 延伸到文本末尾
const [open] = extractFencedCodeBlocks('```mermaid\nflowchart LR\nA --')
assert.equal(open.lang, 'mermaid')
assert.equal(open.done, false)
assert.equal(open.source, 'flowchart LR\nA --')
assert.equal(extractFencedCodeBlocks('```mermaid\nflowchart LR\nA --').length, 1)

// info string 只取第一个 token；大小写归一
const [info] = extractFencedCodeBlocks('```Mermaid title=x\nA\n```')
assert.equal(info.lang, 'mermaid')

// 波浪线围栏 + 更长围栏嵌套（CommonMark：更短围栏不构成闭合）
assert.equal(extractFencedCodeBlocks('~~~mermaid\nA\n~~~')[0].done, true)
const nested = '````\nx\n```\ny\n````'
assert.equal(extractFencedCodeBlocks(nested)[0].lang, '')
assert.equal(extractFencedCodeBlocks(nested)[0].source, 'x\n```\ny')
assert.equal(extractMermaidBlocks(nested).length, 0)

// 单个 ``` 行也能开栏；无闭合围栏时按 CommonMark 语义延伸到 EOF（done=false，与 remark 一致）
const [lone] = extractFencedCodeBlocks('a\n```\nb')
assert.equal(lone.lang, '')
assert.equal(lone.done, false)
assert.equal(lone.source, 'b')

// 多个块：语言各自的，mermaid 过滤器只留 mermaid
const mixed = '```js\nconst a=1\n```\nmid\n```mermaid\nA\n```\nend\n```mermaid\nB'
const all = extractFencedCodeBlocks(mixed)
assert.deepEqual(all.map(b => b.lang), ['js', 'mermaid', 'mermaid'])
assert.deepEqual(all.map(b => b.done), [true, true, false])
const onlyMermaid = extractMermaidBlocks(mixed)
assert.deepEqual(onlyMermaid.map(b => b.source), ['A', 'B'])
assert.equal(onlyMermaid[1].done, false)

// ---------- 消息切分（流式增量出图的核心纯函数） ----------

// 禁用图表：永远单段 Markdown
assert.deepEqual(splitMermaidSegments('```mermaid\nA\n```', false), [{ type: 'markdown', key: 'm-0', content: '```mermaid\nA\n```' }])
assert.deepEqual(splitMermaidSegments('', true), [])

// 无 mermaid 块：单段
assert.equal(splitMermaidSegments('just text', true).length, 1)

// 已闭合块：前后文字 + 图表节点，source 不含围栏（闭合围栏后的换行随块消费，下一段从下一行起始）
const segs = splitMermaidSegments(one, true)
assert.equal(segs.length, 3)
assert.deepEqual(segs[0], { type: 'markdown', key: 'm-0', content: 'text\n' })
assert.deepEqual(segs[1], { type: 'mermaid', key: 'd-1', source: 'flowchart LR\nA --> B' })
assert.deepEqual(segs[2], { type: 'markdown', key: 'm-2', content: 'tail' })

// 流式进行中：块未闭合 → 整段仍是 Markdown（半截源码按普通代码块展示）
const streaming = splitMermaidSegments('```mermaid\nflowchart LR\nA --', true)
assert.equal(streaming.length, 1)
assert.equal(streaming[0].type, 'markdown')
assert.equal(streaming[0].content, '```mermaid\nflowchart LR\nA --')

// 流式到达闭合围栏的下一帧：同一函数调用即切出图表（无需整条消息完成）
const closed = splitMermaidSegments('intro\n```mermaid\nA\n```\nmore text coming…', true)
assert.equal(closed.length, 3)
assert.equal(closed[1].type, 'mermaid')
assert.equal((closed[1] as { source: string }).source, 'A')
assert.equal(closed[2].type, 'markdown')
assert.equal((closed[2] as { content: string }).content, 'more text coming…')

// 多个 mermaid 块：已闭合的先出图，末尾未闭合的暂按源码
const multi = splitMermaidSegments('a\n```mermaid\nA\n```\nb\n```mermaid\nC\nD -->', true)
assert.deepEqual(multi.map(n => n.type), ['markdown', 'mermaid', 'markdown'])
assert.equal((multi[1] as { source: string }).source, 'A')
assert.equal(multi[2].content, 'b\n```mermaid\nC\nD -->')

// 图表块之间没有多余文本时不产生空 Markdown 片段
const adjacent = splitMermaidSegments('```mermaid\nA\n```\n```mermaid\nB\n```', true)
assert.deepEqual(adjacent.map(n => n.type), ['mermaid', 'mermaid'])

// 片段与图表块按序拼接（含围栏；闭合围栏后的换行随块消费，还原时补回）可以无损还原原文
assert.equal(
  segs[0].content + '```mermaid\n' + segs[1].source + '\n```\n' + segs[2].content,
  one
)

// ---------- 独立 SVG 导出（源码注释转义 + xmlns/宽高 + 背景矩形） ----------

// 典型 Mermaid 源码：箭头与边标签里的 "--" 全部拆开，注释体不得再出现 "--"
const standalone = buildStandaloneSvg(
  '<svg viewBox="0 0 300 100"><g/></svg>',
  'graph LR\nA -- note --> B\nC -->|x| D\n%% comment',
  '#1d2228'
)
assert.equal(
  standalone,
  '<!--\ngraph LR\nA    note   > B\nC   >|x| D\n%% comment\n-->\n'
  + '<svg width="300" height="100" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">'
  + '<rect width="300" height="100" fill="#1d2228"/><g/></svg>'
)
// 注释体（首尾分隔符之间）不得包含 "--"：浏览器 XML 解析器会直接报错
const commentBody = /<!--([\s\S]*?)-->/.exec(standalone)?.[1] || ''
assert.ok(!commentBody.includes('--'))
assert.ok(validateStandaloneSvg(standalone))

// 已有 xmlns/width 时不重复注入，背景矩形仍插入
assert.equal(
  buildStandaloneSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 10 20"><g/></svg>',
    '', '#ffffff'
  ),
  '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 10 20">'
  + '<rect width="10" height="20" fill="#ffffff"/><g/></svg>'
)
// 无 viewBox 时仅补 xmlns，背景矩形用 100%
assert.equal(
  buildStandaloneSvg('<svg><g/></svg>', '', '#fff'),
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/><g/></svg>'
)
// 非 SVG 内容原样返回（仅带注释头）
assert.equal(
  buildStandaloneSvg('<div>x</div>', 'graph TD\nA --> B', '#fff'),
  '<!--\ngraph TD\nA   > B\n-->\n<div>x</div>'
)
// 三连破折号等边界：转义后注释体不得残留任何 "--"
assert.ok(!escapeXmlCommentBody('A --- B').includes('--'))
assert.ok(!escapeXmlCommentBody('A ---> B').includes('--'))
assert.equal(escapeXmlCommentBody('a - b'), 'a - b')
// 空源码不生成注释头
assert.equal(buildStandaloneSvg('<svg><g/></svg>', '', '#fff'), buildStandaloneSvg('<svg><g/></svg>', '', '#fff'))
assert.ok(!buildStandaloneSvg('<svg><g/></svg>', '', '#fff').startsWith('<!--'))

// ---------- 落盘前安全校验 ----------

assert.ok(validateStandaloneSvg('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'))
assert.ok(!validateStandaloneSvg('<p>not svg</p>'))
// 注释体含未转义的 "--" 必须拒绝（这正是之前导出文件在浏览器里炸掉的形态）
assert.ok(!validateStandaloneSvg('<!--\ngraph LR\nA -- note --> B\n-->\n<svg xmlns="x"/>'))

console.log('diagram policy tests passed')
