import { existsSync } from 'node:fs'

// Keep production runner, compactor, context resolver and provider. Isolate only network/config/memory IO.
export function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/src/main/')) {
    const stem = specifier.replace(/\.ts$/, '')
    const source = stem.endsWith('/net/fetch') ? 'export function getFetch() { return globalThis.fetch }'
      : stem.endsWith('/store/db') ? 'export function getSettings() { return { maxRetries: 0, providers: [] } }'
      : stem.endsWith('/memory/manager') ? 'export function buildMemoryPrompt() { return "" }; export async function captureMemories() {}'
      : undefined
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      const url = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
