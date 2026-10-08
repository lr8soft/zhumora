import type { AppSettings, Session } from '../../shared/types.ts'
import { validateSessionModelSelection } from '../../shared/sessionModel.ts'
import type { SessionStore } from './sessionContracts.ts'

export function saveSessionModelSelection(store: SessionStore, sessionId: string, value: unknown) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Invalid session ID.')
  const session = store.getSession(sessionId)
  if (!session) throw new Error('Session not found.')
  const selection = validateSessionModelSelection(value)
  if (selection) resolveSessionModel(store.getSettings(), { ...session, modelSelection: selection })
  store.updateSessionModelSelection(sessionId, selection)
  return selection
}

/** An explicit provider switch must not inherit another endpoint's saved model. */
export function resolveSessionModel(
  settings: AppSettings, session: Session, request: { providerId?: string; modelOverride?: string } = {}
) {
  const saved = session.modelSelection ?? session.subagent
  const providerId = request.providerId ?? saved?.providerId ?? settings.activeProviderId
  const provider = settings.providers.find(item => item.id === providerId)
  if (!provider) throw new Error('No active provider. The selected provider may have been removed; please configure one in Settings.')
  if (!provider.enabled) throw new Error('Selected provider is disabled.')
  const modelOverride = request.modelOverride ?? (provider.id === saved?.providerId ? saved.model : undefined)
  return { provider, modelOverride }
}
