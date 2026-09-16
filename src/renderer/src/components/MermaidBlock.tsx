import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Code2, Copy, LoaderCircle, Workflow } from 'lucide-react'

import { useAppStore } from '../store'
import { useMermaidRenderer } from '../mermaidContext'
import { MermaidRenderError, type MermaidTheme } from '../mermaidRenderer'

interface Props {
  source: string
}

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; message: string }

export default function MermaidBlock({ source }: Props) {
  const { t } = useTranslation()
  const renderer = useMermaidRenderer()
  const appTheme = useAppStore(s => s.theme)
  const resolvedTheme = useResolvedTheme(appTheme)
  const [renderState, setRenderState] = useState<RenderState>({ status: 'loading' })
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    setRenderState({ status: 'loading' })
    void renderer.render(source, resolvedTheme).then(
      svg => { if (active) setRenderState({ status: 'ready', svg }) },
      error => {
        if (!active) return
        const key = error instanceof MermaidRenderError && error.code === 'too-large'
          ? 'diagram.tooLarge'
          : 'diagram.renderError'
        const detail = error instanceof Error ? error.message : String(error)
        setRenderState({ status: 'error', message: `${t(key)} ${detail}`.trim() })
      }
    )
    return () => { active = false }
  }, [renderer, resolvedTheme, source, t])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const sourceVisible = showSource || renderState.status === 'error'

  return (
    <div className="mermaid-block">
      <div className="mermaid-toolbar">
        <span className="mermaid-title"><Workflow size={14} />{t('diagram.title')}</span>
        <div className="mermaid-actions">
          {renderState.status === 'ready' && (
            <button onClick={() => setShowSource(!showSource)}>
              {showSource ? <Workflow size={13} /> : <Code2 size={13} />}
              {showSource ? t('diagram.showDiagram') : t('diagram.showSource')}
            </button>
          )}
          <button onClick={() => void copySource()}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? t('diagram.copied') : t('diagram.copySource')}
          </button>
        </div>
      </div>

      {renderState.status === 'loading' && (
        <div className="mermaid-status" aria-live="polite">
          <LoaderCircle size={16} className="spin" />
          {t('diagram.rendering')}
        </div>
      )}
      {renderState.status === 'error' && (
        <div className="mermaid-error" role="alert">
          <AlertTriangle size={15} />
          <span>{renderState.message}</span>
        </div>
      )}
      {renderState.status === 'ready' && !sourceVisible && (
        <div
          className="mermaid-canvas"
          role="img"
          aria-label={t('diagram.accessibleLabel')}
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      )}
      {sourceVisible && (
        <pre className="mermaid-source"><code>{source}</code></pre>
      )}
    </div>
  )
}

function useResolvedTheme(theme: 'light' | 'dark' | 'system'): MermaidTheme {
  const resolve = (): MermaidTheme => theme === 'dark'
    || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'dark'
    : 'light'
  const [resolved, setResolved] = useState<MermaidTheme>(resolve)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setResolved(resolve())
    update()
    if (theme === 'system') media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [theme])

  return resolved
}
