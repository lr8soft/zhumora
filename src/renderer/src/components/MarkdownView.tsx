import React, { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { isMermaidCodeClass, normalizeCodeSource } from '../diagramPolicy'
import MermaidBlock from './MermaidBlock'

interface Props {
  content: string
  enableDiagrams?: boolean
}

function MarkdownView({ content, enableDiagrams = false }: Props) {
  const components = useMemo<Components>(() => ({
    pre({ children, ...props }) {
      const child = React.Children.toArray(children)[0]
      if (enableDiagrams && React.isValidElement<{ className?: string }>(child)
        && isMermaidCodeClass(child.props.className)) {
        return <>{children}</>
      }
      return <pre {...props}>{children}</pre>
    },
    code({ children, className, node: _node, ...props }) {
      if (enableDiagrams && isMermaidCodeClass(className)) {
        return <MermaidBlock source={normalizeCodeSource(children)} />
      }
      return <code className={className} {...props}>{children}</code>
    }
  }), [enableDiagrams])

  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
}

export default React.memo(MarkdownView)
