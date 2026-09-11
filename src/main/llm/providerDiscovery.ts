export function createProviderDiscoveryHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

export function providerDiscoveryCacheKey(baseUrl: string, apiKey: string): string {
  return `${baseUrl}::${apiKey || 'anonymous'}`
}
