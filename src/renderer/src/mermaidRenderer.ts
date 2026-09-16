import DOMPurify from 'dompurify'
import type { Mermaid } from 'mermaid'

import { containsExternalCssReference, MAX_MERMAID_SOURCE_LENGTH, validateMermaidSource } from './diagramPolicy'

export type MermaidTheme = 'light' | 'dark'
export type MermaidRenderErrorCode = 'empty' | 'too-large' | 'render-failed'

export class MermaidRenderError extends Error {
  constructor(readonly code: MermaidRenderErrorCode, message: string) {
    super(message)
    this.name = 'MermaidRenderError'
  }
}

/**
 * Renderer 进程级 Mermaid 生命周期 owner。
 *
 * Mermaid 配置是库级可变状态，因此所有 initialize + render 必须串行。缓存按
 * theme + 完整 source 失效，最多保存 32 个 SVG，并可由组合根显式清理。
 */
export class MermaidRenderer {
  private mermaidPromise: Promise<Mermaid> | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly cache = new Map<string, string>()
  private readonly inflight = new Map<string, Promise<string>>()
  private sequence = 0

  render(source: string, theme: MermaidTheme): Promise<string> {
    const validation = validateMermaidSource(source)
    if (validation === 'empty') return Promise.reject(new MermaidRenderError('empty', 'Diagram source is empty.'))
    if (validation === 'too-large') {
      return Promise.reject(new MermaidRenderError(
        'too-large',
        `Diagram source exceeds ${MAX_MERMAID_SOURCE_LENGTH.toLocaleString()} characters.`
      ))
    }

    const key = `${theme}\0${source}`
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return Promise.resolve(cached)
    }
    const pending = this.inflight.get(key)
    if (pending) return pending

    const request = this.enqueue(async () => {
      const mermaid = await this.getMermaid()
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        secure: [
          'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels',
          'dompurifyConfig', 'theme', 'themeCSS', 'themeVariables', 'fontFamily',
          'altFontFamily', 'look', 'layout', 'suppressErrorRendering', 'deterministicIds'
        ],
        htmlLabels: false,
        maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
        maxEdges: 500,
        dompurifyConfig: {
          FORBID_TAGS: ['script', 'style', 'foreignObject', 'iframe', 'object', 'embed', 'a']
        },
        suppressErrorRendering: true,
        deterministicIds: true,
        theme: theme === 'dark' ? 'dark' : 'default',
        logLevel: 'fatal'
      })
      const id = `zhumora-mermaid-${++this.sequence}`
      const { svg } = await mermaid.render(id, source)
      const sanitized = String(DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'a'],
        FORBID_ATTR: ['href', 'xlink:href']
      }))
      const hardened = stripExternalCssReferences(sanitized)
      if (!hardened.includes('<svg')) {
        throw new MermaidRenderError('render-failed', 'Mermaid did not produce a valid SVG.')
      }
      this.cache.set(key, hardened)
      while (this.cache.size > 32) {
        const oldest = this.cache.keys().next().value
        if (oldest === undefined) break
        this.cache.delete(oldest)
      }
      return hardened
    }).catch(error => {
      if (error instanceof MermaidRenderError) throw error
      throw new MermaidRenderError('render-failed', readableError(error))
    }).finally(() => {
      this.inflight.delete(key)
    })

    this.inflight.set(key, request)
    return request
  }

  clear(): void {
    this.cache.clear()
  }

  private getMermaid(): Promise<Mermaid> {
    this.mermaidPromise ??= import('mermaid').then(module => module.default)
    return this.mermaidPromise
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Unable to render Mermaid diagram.'
}

/**
 * DOMPurify handles markup and URI attributes. Mermaid still needs local
 * `url(#marker-id)` CSS references, so remove only non-local CSS resources.
 */
function stripExternalCssReferences(svg: string): string {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = document.documentElement
  if (root.localName !== 'svg') return ''

  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (containsExternalCssReference(attribute.value)) element.removeAttribute(attribute.name)
    }
  }
  for (const style of Array.from(root.querySelectorAll('style'))) {
    if (containsExternalCssReference(style.textContent || '') || /@import\b/i.test(style.textContent || '')) {
      style.remove()
    }
  }
  return root.outerHTML
}
