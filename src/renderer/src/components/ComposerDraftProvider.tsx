import { createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'

interface ComposerDraft { input: string; images: string[]; error: string | null; preferParallel: boolean }
const DraftContext = createContext<{ draft: ComposerDraft; setDraft: Dispatch<SetStateAction<ComposerDraft>> } | null>(null)

/** This owner stays outside dock/portal mounts. Only the composer consumes draft updates; the graph does not. */
export function ComposerDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<ComposerDraft>({ input: '', images: [], error: null, preferParallel: false })
  const value = useMemo(() => ({ draft, setDraft }), [draft])
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>
}

export function useComposerDraft() {
  const context = useContext(DraftContext)
  if (!context) throw new Error('Composer requires its session draft owner')
  return context
}
