import assert from 'node:assert/strict'
import { providerDiscoveryCacheKey } from '../src/main/llm/providerDiscovery.ts'

const provider = { baseUrl: 'http://localhost/v1', apiKey: '' }
assert.notEqual(
  providerDiscoveryCacheKey(provider),
  providerDiscoveryCacheKey({ ...provider, apiKey: 'secret' }),
  'anonymous discovery must not reuse an authenticated model list'
)
assert.notEqual(providerDiscoveryCacheKey(provider), providerDiscoveryCacheKey({ ...provider, headers: { 'X-Key': 'secret' } }),
  'custom credentials must invalidate the model list')
assert.notEqual(providerDiscoveryCacheKey({ ...provider, apiKey: 'first' }), providerDiscoveryCacheKey({ ...provider, apiKey: 'second' }))
assert.equal(providerDiscoveryCacheKey({ ...provider, headers: { X: '1', Y: '2' } }),
  providerDiscoveryCacheKey({ ...provider, headers: { y: '2', x: '1' } }), 'header ordering and casing are semantic equivalents')
assert.ok(!providerDiscoveryCacheKey({ ...provider, apiKey: 'secret' }).includes('secret'), 'cache keys do not retain plaintext credentials')

console.log('provider model listing tests passed')
