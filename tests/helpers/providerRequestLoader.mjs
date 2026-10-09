import { existsSync } from 'node:fs'

// Isolate only network/config IO; requests still execute the production adapters.
export function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/src/main/')) {
    const source = specifier.endsWith('/net/fetch')
      ? 'export function getFetch() { return globalThis.fetch }'
      : specifier.endsWith('/store/db')
        ? 'export function getSettings() { return { maxRetries: 0, useSystemCerts: false } }'
        : null
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      const url = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
