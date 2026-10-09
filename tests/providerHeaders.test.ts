import assert from 'node:assert/strict'
import {
  createProviderRequestHeaders, normalizeProviderHeaders, parseProviderHeaders,
  formatProviderHeaders, providerRequestIdentity, validateProviderRequest
} from '../src/shared/providerHeaders.ts'
import { normalizeSettings, SETTINGS_SCHEMA_VERSION } from '../src/main/store/settingsNormalization.ts'

const provider = { id: 'p', name: 'test', baseUrl: 'https://example.com/v1', apiKey: 'secret', defaultModel: 'm', enabled: true }
assert.deepEqual(createProviderRequestHeaders(provider), { 'content-type': 'application/json', authorization: 'Bearer secret' })
assert.deepEqual(createProviderRequestHeaders({ apiKey: '', headers: { 'X-API-Key': 'custom' } }), {
  'content-type': 'application/json', 'x-api-key': 'custom'
})
assert.deepEqual(createProviderRequestHeaders({ ...provider, headers: { AUTHORIZATION: 'Token custom', 'Content-Type': 'custom/type' } }), {
  'content-type': 'custom/type', authorization: 'Token custom'
})
assert.equal(createProviderRequestHeaders({ ...provider, headers: { Authorization: '' } }).authorization, '')
assert.deepEqual(parseProviderHeaders('X-Key: value:with:colons\r\n\nAuthorization: Token abc'), {
  'x-key': 'value:with:colons', authorization: 'Token abc'
})
assert.deepEqual(parseProviderHeaders(''), {})
assert.deepEqual(parseProviderHeaders(formatProviderHeaders({ 'x-key': 'value' })), { 'x-key': 'value' })
for (const text of ['missing colon', ': value', 'Bad Name: x', 'X: one\nx: two', 'X: one\rInjected: value']) {
  assert.throws(() => parseProviderHeaders(text))
}
for (const headers of [null, [], 'x', { X: 1 }, { 'Bad Name': 'x' }, { X: 'a\nb' }, { X: 'a\0b' }, { X: '中文' }, { X: 'one', x: 'two' }]) {
  assert.throws(() => normalizeProviderHeaders(headers))
}
assert.deepEqual(normalizeProviderHeaders(undefined), {})
assert.equal(providerRequestIdentity({ ...provider, headers: { Z: '2', A: '1' } }),
  providerRequestIdentity({ ...provider, headers: { a: '1', z: '2' } }))
assert.notEqual(providerRequestIdentity(provider), providerRequestIdentity({ ...provider, apiKey: 'other' }))
assert.notEqual(providerRequestIdentity(provider), providerRequestIdentity({ ...provider, headers: { 'X-Tenant': 'one' } }))
assert.deepEqual(validateProviderRequest(provider).headers, {})
assert.throws(() => validateProviderRequest({ ...provider, baseUrl: 'file:///tmp' }))
assert.throws(() => validateProviderRequest({ ...provider, headers: { X: 'secret\ninjected' } }))

const legacy = normalizeSettings({ schemaVersion: 12, providers: [provider], activeProviderId: 'p' })
assert.equal(legacy.schemaVersion, SETTINGS_SCHEMA_VERSION)
assert.deepEqual(legacy.providers[0].headers, {})
assert.equal(legacy.providers[0].apiKey, 'secret')
assert.deepEqual(normalizeSettings(null).providers[0].headers, {})
const saved = normalizeSettings({ ...legacy, providers: [{ ...provider, headers: { 'X-API-Key': 'custom' } }] })
assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(saved))).providers[0].headers, { 'x-api-key': 'custom' })
assert.throws(() => normalizeSettings({ providers: [{ ...provider, headers: { X: 'bad\nvalue' } }] }))
const inputHeaders = { X: 'copy' }
const copy = normalizeSettings({ providers: [{ ...provider, headers: inputHeaders }] })
inputHeaders.X = 'mutated'
assert.equal(copy.providers[0].headers?.x, 'copy')
console.log('Provider custom header validation, merging and settings migration tests passed')
