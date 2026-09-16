import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, ChevronDown, Code2, Copy, Download, LoaderCircle, Workflow } from 'lucide-react'

import { encodeCanvasImage } from '../diagramPolicy'
import { useAppStore } from '../store'
import { useMermaidRenderer } from '../mermaidContext'
import { MermaidRenderError, type MermaidTheme } from '../mermaidRenderer'
import { buildStandaloneSvg } from '../../../shared/diagram'

interface Props {
  source: string
}

type DiagramFormat = 'svg' | 'png' | 'jpeg'

const DIAGRAM_FORMATS: DiagramFormat[] = ['svg', 'png', 'jpeg']

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
  const [saved, setSaved] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [exporting, setExporting] = useState<DiagramFormat | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

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

  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), 1500)
    return () => window.clearTimeout(timer)
  }, [saved])

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const saveDiagram = async (format: DiagramFormat) => {
    if (renderState.status !== 'ready' || exporting) return
    setMenuOpen(false)
    // 背景与图表容器一致：light 白、dark #1d2228（--app-color-surface），避免导出后深底深字
    const background = resolvedTheme === 'dark' ? '#1d2228' : '#ffffff'
    if (format === 'svg') {
      // renderer 组装独立 SVG（源码注释转义 + 背景矩形），main 只负责落盘
      const result = await window.api.settings.saveDiagram(
        buildStandaloneSvg(renderState.svg, source, background), 'svg', 'diagram.svg'
      )
      setSaved(result === 'saved')
      return
    }
    // PNG/JPEG：光栅化在 renderer 完成（OffscreenCanvas 2x），main 只写 Buffer
    setExporting(format)
    try {
      const dataUrl = await encodeCanvasImage(
        renderState.svg,
        format === 'png' ? 'image/png' : 'image/jpeg',
        background
      )
      const result = await window.api.settings.saveDiagram(dataUrl, format, format === 'png' ? 'diagram.png' : 'diagram.jpeg')
      setSaved(result === 'saved')
    } catch (error) {
      console.error('Diagram export error:', error)
    } finally {
      setExporting(null)
    }
  }

  const sourceVisible = showSource || renderState.status === 'error'

  return (
    <div className="mermaid-block">
      <div className="mermaid-toolbar">
        <span className="mermaid-title"><Workflow size={14} />{t('diagram.title')}</span>
        <div className="mermaid-actions">
          {renderState.status === 'ready' && (
            <>
              <button onClick={() => setShowSource(!showSource)}>
                {showSource ? <Workflow size={13} /> : <Code2 size={13} />}
                {showSource ? t('diagram.showDiagram') : t('diagram.showSource')}
              </button>
              <div className="mermaid-save-menu" ref={menuRef}>
                <button
                  onClick={() => setMenuOpen(v => !v)}
                  disabled={exporting !== null}
                  aria-expanded={menuOpen}
                >
                  {exporting
                    ? <LoaderCircle size={13} className="spin" />
                    : saved ? <Check size={13} /> : <Download size={13} />}
                  {exporting
                    ? t('diagram.exporting')
                    : saved ? t('diagram.saved') : t('diagram.save')}
                  <ChevronDown size={12} className={menuOpen ? 'rotated' : ''} />
                </button>
                {menuOpen && (
                  <div className="mermaid-save-menu-list">
                    {DIAGRAM_FORMATS.map(format => (
                      <button key={format} onClick={() => void saveDiagram(format)}>
                        {t(`diagram.format.${format}`)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
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
