import type { McpServerConfig } from './types'

// RFC 9110 field-name = token. Keeping this check shared lets every config
// entry point reject the same malformed names before they reach fetch.
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export function isValidHttpHeaderName(name: string): boolean {
  return HEADER_NAME_RE.test(name)
}

export function isValidHttpHeaderValue(value: string): boolean {
  return !/[\r\n\0]/.test(value)
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const existing = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase())
  if (existing && existing !== name) delete headers[existing]
  headers[name] = value
}

/** Convert the settings textarea into a fetch-compatible header map. */
export function parseMcpHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim()
    const headerValue = line.slice(colon + 1).trim()
    if (!isValidHttpHeaderName(name) || !isValidHttpHeaderValue(headerValue)) continue
    setHeader(headers, name, headerValue)
  }
  return headers
}

export function formatMcpHeaders(headers: Record<string, string> | undefined): string {
  return Object.entries(headers || {}).map(([name, value]) => `${name}: ${value}`).join('\n')
}

/**
 * Build remote MCP request headers. Shortcut authentication intentionally wins
 * case-insensitively over an identically named custom header.
 */
export function buildMcpRequestHeaders(config: McpServerConfig): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(config.headers || {})) {
    if (!isValidHttpHeaderName(name) || !isValidHttpHeaderValue(value)) continue
    setHeader(headers, name, value)
  }

  if (config.authType === 'bearer' && config.authToken) {
    setHeader(headers, 'Authorization', `Bearer ${config.authToken}`)
  } else if (config.authType === 'apikey' && config.apiKey) {
    const requestedName = config.authHeader?.trim() || 'X-API-Key'
    const name = isValidHttpHeaderName(requestedName) ? requestedName : 'X-API-Key'
    setHeader(headers, name, config.apiKey)
  }

  return headers
}
