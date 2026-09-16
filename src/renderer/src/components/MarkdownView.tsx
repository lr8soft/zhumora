import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { splitMermaidSegments } from '../diagramPolicy'
import MermaidBlock from './MermaidBlock'

interface Props {
  content: string
  enableDiagrams?: boolean
}

function MarkdownView({ content, enableDiagrams = false }: Props) {
  const nodes = useMemo(() => splitMermaidSegments(content, enableDiagrams), [content, enableDiagrams])

  if (nodes.length === 1 && nodes[0].type === 'markdown') {
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{nodes[0].content}</ReactMarkdown>
  }

  return (
    <>
      {nodes.map(node => node.type === 'markdown'
        ? <ReactMarkdown key={node.key} remarkPlugins={[remarkGfm]}>{node.content}</ReactMarkdown>
        : <MermaidBlock key={node.key} source={node.source} />)}
    </>
  )
}

export default React.memo(MarkdownView)
