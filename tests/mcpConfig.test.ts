import assert from 'node:assert/strict'
import {
  buildMcpRequestHeaders,
  formatMcpHeaders,
  isValidHttpHeaderName,
  isValidHttpHeaderValue,
  parseMcpHeaders
} from '../src/shared/mcpConfig.ts'
import type { McpServerConfig } from '../src/shared/types.ts'

const remote = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'remote',
  name: 'Remote MCP',
  type: 'streamable-http',
  url: 'https://mcp.example.com',
  enabled: true,
  ...overrides
})

assert.deepEqual(parseMcpHeaders('Authorization: Custom abc\nX-Tenant: one:two\ninvalid line'), {
  Authorization: 'Custom abc',
  'X-Tenant': 'one:two'
})
assert.deepEqual(parseMcpHeaders('X-Key: first\nx-key: second'), { 'x-key': 'second' })
assert.equal(formatMcpHeaders({ Authorization: 'Bearer token', 'X-Tenant': 'tenant-a' }),
  'Authorization: Bearer token\nX-Tenant: tenant-a')

assert.deepEqual(buildMcpRequestHeaders(remote({
  authType: 'custom',
  headers: { Authorization: 'Custom abc', 'X-Tenant': 'tenant-a' }
})), { Authorization: 'Custom abc', 'X-Tenant': 'tenant-a' })

assert.deepEqual(buildMcpRequestHeaders(remote({
  authType: 'bearer',
  authToken: 'new-token',
  headers: { authorization: 'Bearer stale', 'X-Tenant': 'tenant-a' }
})), { Authorization: 'Bearer new-token', 'X-Tenant': 'tenant-a' })

assert.deepEqual(buildMcpRequestHeaders(remote({
  authType: 'apikey',
  authHeader: ' X-Service-Key ',
  apiKey: 'secret',
  headers: { 'x-service-key': 'stale' }
})), { 'X-Service-Key': 'secret' })

assert.equal(isValidHttpHeaderName('X-Service-Key'), true)
assert.equal(isValidHttpHeaderName('Bad Header'), false)
assert.equal(isValidHttpHeaderValue('safe:value'), true)
assert.equal(isValidHttpHeaderValue('unsafe\r\nInjected: yes'), false)
assert.deepEqual(buildMcpRequestHeaders(remote({
  authType: 'custom',
  headers: { 'Bad Header': 'ignored', Safe: 'value', Injected: 'bad\nvalue' }
})), { Safe: 'value' })

console.log('MCP custom header tests passed')
