export const MAX_MERMAID_SOURCE_LENGTH = 50_000

export type MermaidSourceValidation = 'empty' | 'too-large' | null

export function isMermaidCodeClass(className: string | undefined): boolean {
  return className?.split(/\s+/).includes('language-mermaid') === true
}

export function normalizeCodeSource(children: unknown): string {
  return String(children ?? '').replace(/\n$/, '')
}

export function validateMermaidSource(source: string): MermaidSourceValidation {
  if (!source.trim()) return 'empty'
  if (source.length > MAX_MERMAID_SOURCE_LENGTH) return 'too-large'
  return null
}

/** Preserve Mermaid's internal SVG markers while rejecting remote/data CSS resources. */
export function containsExternalCssReference(value: string): boolean {
  const matches = value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)
  for (const match of matches) {
    if (!match[2].trim().startsWith('#')) return true
  }
  return false
}
