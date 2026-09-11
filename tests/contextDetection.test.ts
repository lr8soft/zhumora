import assert from 'node:assert/strict'
import { configuredContextWindow, contextDetectionCacheKey } from '../src/main/agent/contextDetectionPolicy.ts'

const provider = {
  baseUrl: 'http://localhost:11434/v1/context-detection-test',
  apiKey: 'secret',
  contextWindow: 32_000
}

assert.equal(configuredContextWindow(provider, true), 32_000, 'Agent runtime honors an explicit override')
assert.equal(configuredContextWindow(provider, false), null, 'fresh settings detection ignores an old manual value')
assert.notEqual(
  contextDetectionCacheKey({ ...provider, apiKey: '' }, 'large-context-model'),
  contextDetectionCacheKey(provider, 'large-context-model'),
  'anonymous fallback must not poison authenticated context detection'
)

console.log('provider context detection tests passed')
