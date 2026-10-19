import { resolve as resolveRunner } from './runnerCollaborationLoader.mjs'

export function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes('/src/main/') && specifier.replace(/\.ts$/, '').endsWith('/store/db')) {
    const source = 'export function getSettings() { return { maxRetries: 1, providers: [] } }'
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  }
  return resolveRunner(specifier, context, nextResolve)
}
