import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { splitMermaidSegments } from '../diagramPolicy'
import MermaidBlock from './MermaidBlock'

interface Props {
  content: string
  enableDiagrams?: boolean
}

// 链接统一在系统默认浏览器打开：消息里的 <a href> 若走 Chromium 默认行为，
// 会把整个应用窗口导航走（main 的 will-navigate 守卫是最后兜底）。
// mailto: 交给系统邮件客户端；其余非 web 目标（javascript: 等）直接拦截。
function ExternalLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={event => {
        event.preventDefault()
        if (!href) return
        const scheme = href.trim().toLowerCase()
        if (scheme.startsWith('http://') || scheme.startsWith('https://')) void window.api.settings.openExternal(href)
        else if (scheme.startsWith('mailto:')) void window.api.settings.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

function MarkdownView({ content, enableDiagrams = false }: Props) {
  const nodes = useMemo(() => splitMermaidSegments(content, enableDiagrams), [content, enableDiagrams])

  if (nodes.length === 1 && nodes[0].type === 'markdown') {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ExternalLink }}>
        {nodes[0].content}
      </ReactMarkdown>
    )
  }

  return (
    <>
      {nodes.map(node => node.type === 'markdown'
        ? <ReactMarkdown key={node.key} remarkPlugins={[remarkGfm]} components={{ a: ExternalLink }}>{node.content}</ReactMarkdown>
        : <MermaidBlock key={node.key} source={node.source} />)}
    </>
  )
}

export default React.memo(MarkdownView)
