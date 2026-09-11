import { useEffect, useRef, useState } from 'react'
import type { ProviderConfig } from '@shared/types'

interface Options {
  providers: ProviderConfig[]
  activeId: string | null
  onChange: (providers: ProviderConfig[], activeId: string | null) => void
}

const signatureOf = (provider: ProviderConfig) =>
  `${provider.baseUrl}\u0000${provider.apiKey}\u0000${provider.defaultModel}`

export function useProviderContextDetection({ providers, activeId, onChange }: Options) {
  const [detecting, setDetecting] = useState<Record<string, boolean>>({})
  const [detected, setDetected] = useState<Record<string, number>>({})
  const autoSignatures = useRef<Record<string, string>>({})
  const inFlight = useRef(new Set<string>())
  const providersRef = useRef(providers)
  providersRef.current = providers

  const updateProvider = (id: string, contextWindow: number) => {
    const current = providersRef.current
    const idx = current.findIndex(provider => provider.id === id)
    if (idx < 0 || current[idx].contextWindow === contextWindow) return
    const next = [...current]
    next[idx] = { ...next[idx], contextWindow }
    onChange(next, activeId)
  }

  /** Ignore an old manual value and ask the endpoint for a fresh context size. */
  const detectContextWindow = async (provider: ProviderConfig) => {
    const signature = signatureOf(provider)
    const requestKey = `${provider.id}\u0000${signature}`
    if (!provider.baseUrl || inFlight.current.has(requestKey)) return
    if (provider.apiKey) autoSignatures.current[provider.id] = signatureOf(provider)
    inFlight.current.add(requestKey)
    setDetecting(state => ({ ...state, [provider.id]: true }))
    try {
      const result = await window.api.provider.detectContextWindow(provider, provider.defaultModel)
      const current = providersRef.current.find(item => item.id === provider.id)
      // A slow response must not overwrite a newer endpoint, credential, or model.
      if (current && signatureOf(current) === signatureOf(provider) && typeof result.detected === 'number') {
        setDetected(state => ({ ...state, [provider.id]: result.detected! }))
        updateProvider(provider.id, result.detected)
      }
    } catch {
      // Detection is advisory; users can still enter an explicit value.
    } finally {
      inFlight.current.delete(requestKey)
      if (![...inFlight.current].some(key => key.startsWith(`${provider.id}\u0000`))) {
        setDetecting(state => {
          const next = { ...state }
          delete next[provider.id]
          return next
        })
      }
    }
  }

  // Credentialed providers are probed automatically after editing settles.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const provider of providers) {
      if (!provider.baseUrl || !provider.apiKey) {
        delete autoSignatures.current[provider.id]
        continue
      }
      const signature = signatureOf(provider)
      if (autoSignatures.current[provider.id] === signature) continue
      timers.push(setTimeout(() => {
        if (autoSignatures.current[provider.id] !== signature) void detectContextWindow(provider)
      }, 500))
    }
    return () => timers.forEach(clearTimeout)
  }, [providers])

  return { detecting, detected, detectContextWindow }
}
