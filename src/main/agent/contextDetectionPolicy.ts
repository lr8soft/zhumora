interface ContextDetectionConfig {
  baseUrl: string
  apiKey: string
  contextWindow?: number
}

export function configuredContextWindow(provider: ContextDetectionConfig, useConfiguredValue: boolean): number | null {
  return useConfiguredValue && provider.contextWindow && provider.contextWindow > 0
    ? provider.contextWindow
    : null
}

export function contextDetectionCacheKey(provider: ContextDetectionConfig, model: string): string {
  return `${provider.baseUrl}::${model}::${provider.apiKey ? 'authenticated' : 'anonymous'}`
}
