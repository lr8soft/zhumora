import { useEffect, useRef, useState } from 'react'
import type { ProviderConfig, ReasoningCapability } from '@shared/types'

interface Options {
  providers: ProviderConfig[]
  activeId: string | null
  onChange: (providers: ProviderConfig[], activeId: string | null) => void
}

const signatureOf = (provider: ProviderConfig) =>
  `${provider.baseUrl}\u0000${provider.apiKey}\u0000${provider.defaultModel}`

/**
 * Signature for the reasoning-capability probe: only the fields that decide what
 * is probed. Context detection additionally requires a credential, but local
 * endpoints (llama.cpp) usually have no API key and are exactly the ones that
 * declare this capability, so it must not reuse `signatureOf`.
 */
const capabilitySignatureOf = (provider: ProviderConfig) =>
  `${provider.baseUrl}\u0000${provider.defaultModel}`

/**
 * Probes provider endpoints for their declared capabilities: context window and
 * reasoning-effort support. Both are advisory — the context window can be typed
 * manually afterwards, and a missing reasoning declaration is not an error.
 */
export function useProviderContextDetection({ providers, activeId, onChange }: Options) {
  const [detecting, setDetecting] = useState<Record<string, boolean>>({})
  const [detected, setDetected] = useState<Record<string, number>>({})
  const [reasoningCapabilities, setReasoningCapabilities] = useState<Record<string, ReasoningCapability>>({})
  const autoSignatures = useRef<Record<string, string>>({})
  const capabilitySignatures = useRef<Record<string, string>>({})
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

  /**
   * Ask the endpoint for a fresh context size.
   * requested=true（用户显式点"重新探测"）→ 结果覆盖手动值；
   * 缺省（后台自动探测）→ 已有手动值时主进程不返回 detected，不覆盖。
   */
  const detectContextWindow = async (provider: ProviderConfig, requested = false) => {
    const signature = signatureOf(provider)
    const requestKey = `${provider.id}\u0000${signature}`
    if (!provider.baseUrl || inFlight.current.has(requestKey)) return
    if (provider.apiKey) autoSignatures.current[provider.id] = signatureOf(provider)
    inFlight.current.add(requestKey)
    setDetecting(state => ({ ...state, [provider.id]: true }))
    try {
      const result = await window.api.provider.detectContextWindow(provider, provider.defaultModel, requested)
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

  // Capability declaration is probed without a credential (see
  // capabilitySignatureOf) and only re-probed when the target changes.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const provider of providers) {
      if (!provider.baseUrl) {
        delete capabilitySignatures.current[provider.id]
        continue
      }
      const signature = capabilitySignatureOf(provider)
      if (capabilitySignatures.current[provider.id] === signature) continue
      timers.push(setTimeout(() => {
        if (capabilitySignatures.current[provider.id] === signature) return
        capabilitySignatures.current[provider.id] = signature
        void window.api.provider.reasoningCapability(provider, provider.defaultModel)
          .then(capability => {
            const current = providersRef.current.find(item => item.id === provider.id)
            if (!current || capabilitySignatureOf(current) !== signature) return
            setReasoningCapabilities(state => ({ ...state, [provider.id]: capability }))
          })
          .catch(() => {
            // Advisory only: an endpoint without /props simply declares nothing.
          })
      }, 500))
    }
    return () => timers.forEach(clearTimeout)
  }, [providers])

  return { detecting, detected, detectContextWindow, reasoningCapabilities }
}
