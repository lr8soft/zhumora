import { createContext, useContext, type ReactNode } from 'react'

import { MermaidRenderer } from './mermaidRenderer'

const MermaidRendererContext = createContext<MermaidRenderer | null>(null)

export function MermaidRendererProvider({ renderer, children }: {
  renderer: MermaidRenderer
  children: ReactNode
}) {
  return <MermaidRendererContext.Provider value={renderer}>{children}</MermaidRendererContext.Provider>
}

export function useMermaidRenderer(): MermaidRenderer {
  const renderer = useContext(MermaidRendererContext)
  if (!renderer) throw new Error('MermaidRendererProvider is missing from the renderer composition root.')
  return renderer
}
