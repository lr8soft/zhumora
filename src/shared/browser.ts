export const BROWSER_TARGETS = ['chrome', 'msedge', 'custom'] as const
export type BrowserTarget = typeof BROWSER_TARGETS[number]

export function normalizeBrowserTarget(value: unknown): BrowserTarget {
  return BROWSER_TARGETS.includes(value as BrowserTarget) ? value as BrowserTarget : 'chrome'
}

export function normalizeCustomBrowserPath(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
