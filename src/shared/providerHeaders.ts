import type { ProviderConfig } from './types.ts'

type ProviderRequestConfig = Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'headers'>

/** HTTP names are case-insensitive; canonicalize once and reject ambiguous duplicates. */
export function normalizeProviderHeaders(input: unknown): Record<string, string> {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid provider headers: expected an object')
  }
  const entries: [string, string][] = []
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(input)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error('Invalid provider header name')
    }
    // Match HTTP value validation without echoing credentials into errors.
    if (typeof value !== 'string' || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
      throw new Error('Invalid provider header value')
    }
    const key = name.toLowerCase()
    if (seen.has(key)) throw new Error('Duplicate provider header name')
    seen.add(key)
    entries.push([key, value.trim()])
  }
  return Object.fromEntries(entries)
}

/** Explicit headers override defaults, including Authorization, regardless of casing. */
export function createProviderRequestHeaders(provider: Pick<ProviderConfig, 'apiKey' | 'headers'>): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    ...normalizeProviderHeaders(provider.headers)
  }
}

/** Semantic identity for caches and stale-response guards; never display or log it. */
export function providerRequestIdentity(provider: ProviderRequestConfig): string {
  const headers = Object.entries(createProviderRequestHeaders(provider)).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([provider.baseUrl.replace(/\/$/, ''), headers])
}

export function parseProviderHeaders(text: string): Record<string, string> {
  const entries: [string, string][] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const colon = line.indexOf(':')
    if (colon <= 0) throw new Error('Invalid provider header line: expected Name: value')
    entries.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
  }
  // Detect duplicates before Object.fromEntries could silently discard a line.
  const names = entries.map(([name]) => name.toLowerCase())
  if (new Set(names).size !== names.length) throw new Error('Duplicate provider header name')
  return normalizeProviderHeaders(Object.fromEntries(entries))
}

export function formatProviderHeaders(headers?: Record<string, string>): string {
  return Object.entries(headers ?? {}).map(([name, value]) => `${name}: ${value}`).join('\n')
}

/** Renderer discovery requests carry unsaved settings, so validate before any network IO. */
export function validateProviderRequest(input: unknown): ProviderConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid provider configuration')
  const provider = input as ProviderConfig
  for (const field of ['id', 'name', 'baseUrl', 'apiKey', 'defaultModel'] as const) {
    if (typeof provider[field] !== 'string') throw new Error(`Invalid provider ${field}`)
  }
  if (typeof provider.enabled !== 'boolean') throw new Error('Invalid provider enabled')
  const url = new URL(provider.baseUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid provider URL protocol')
  return { ...provider, headers: normalizeProviderHeaders(provider.headers) }
}
