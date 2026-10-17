import { existsSync } from 'node:fs'

const fixture = new URL('./windowAdaptersFixture.mjs', import.meta.url).href
export function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/src/main/')) {
    if (specifier === 'electron' || specifier.replace(/\.ts$/, '').endsWith('/llm/logger')) {
      return { url: fixture, shortCircuit: true }
    }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      const url = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
