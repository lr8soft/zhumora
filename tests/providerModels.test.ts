import assert from 'node:assert/strict'
import { createProviderDiscoveryHeaders, providerDiscoveryCacheKey } from '../src/main/llm/providerDiscovery.ts'

assert.deepEqual(createProviderDiscoveryHeaders(''), {
  'Content-Type': 'application/json'
}, 'model discovery must not require an API key')
assert.deepEqual(createProviderDiscoveryHeaders('secret'), {
  'Content-Type': 'application/json',
  Authorization: 'Bearer secret'
})
assert.notEqual(
  providerDiscoveryCacheKey('http://localhost/v1', ''),
  providerDiscoveryCacheKey('http://localhost/v1', 'secret'),
  'anonymous discovery must not reuse an authenticated model list'
)

console.log('provider model listing tests passed')
