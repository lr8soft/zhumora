import type { Session } from '../../../shared/types.ts'
import type { SessionModelSelection } from '../../../shared/sessionModel.ts'

export interface SessionModelSlice {
  setSessionModelSelection: (sessionId: string, selection: SessionModelSelection | null) => Promise<void>
  waitForSessionModelSelection: (sessionId: string) => Promise<void>
}

export function sessionModelSelection(session: Session | undefined): SessionModelSelection | null {
  return session?.modelSelection ?? (session?.subagent
    ? { providerId: session.subagent.providerId, model: session.subagent.model } : null)
}

/** Pending writes are owned by this store instance, keyed by session, and released on settle.
 * Keep confirmed values in the session projection and serialize rapid choices so a late reply
 * cannot restore an older choice. Sending/compacting waits only for its own session's writes. */
export function createSessionModelSlice(
  set: (update: (state: { sessions: Session[] }) => { sessions: Session[] }) => void,
  save: (sessionId: string, selection: SessionModelSelection | null) => Promise<SessionModelSelection | null>
): SessionModelSlice {
  const pending = new Map<string, Promise<void>>()
  return {
    setSessionModelSelection(sessionId, selection) {
      const previous = pending.get(sessionId) ?? Promise.resolve()
      const write = previous.catch(() => {}).then(async () => {
        const saved = await save(sessionId, selection)
        set(state => ({ sessions: state.sessions.map(session => session.id === sessionId
          ? { ...session, modelSelection: saved } : session) }))
      }).finally(() => {
        if (pending.get(sessionId) === write) pending.delete(sessionId)
      })
      pending.set(sessionId, write)
      return write
    },
    async waitForSessionModelSelection(sessionId) {
      while (pending.has(sessionId)) await pending.get(sessionId)
    }
  }
}
