import { existsSync } from 'node:fs'

// Only replace configuration/memory/context IO; run the production runner, tool executor and provider stream parser.
export function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/src/main/')) {
    const stem = specifier.replace(/\.ts$/, '')
    const source = stem.endsWith('/net/fetch') ? 'export function getFetch() { return globalThis.fetch }'
      : stem.endsWith('/store/db') ? 'export function getSettings() { return { maxRetries: 0, providers: [] } }'
      : stem.endsWith('/memory/manager') ? 'export function buildMemoryPrompt() { return "" }; export async function captureMemories() {}'
      : stem.endsWith('/agent/context') || stem === './context'
        ? 'export async function fetchContextWindow() { return 1000000 }; export async function planAutoCompact() { throw new Error("unexpected compaction IO") }; export function makeSummaryMessage() { throw new Error("unexpected summary") }'
        : undefined
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      const url = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
