import { useTranslation } from 'react-i18next'
import { GitFork } from 'lucide-react'
import { useComposerDraft } from './ComposerDraftProvider'
import { useAppStore } from '../store'

export default function ComposerCollaborationToggle({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const { draft, setDraft } = useComposerDraft()
  const available = useAppStore(state => state.settings.subagentsEnabled && !state.sessions.find(session => session.id === sessionId)?.subagent)
  return <button type="button" className="composer-mode-chip composer-collaboration-chip" disabled={!available}
    aria-label={t('chat.parallel')} aria-pressed={available && draft.preferParallel} title={t(available ? 'chat.parallelHint' : 'chat.parallelDisabledHint')}
    onClick={() => setDraft(previous => ({ ...previous, preferParallel: !previous.preferParallel }))}>
    <GitFork size={13} /><span>{t('chat.parallel')}</span>
  </button>
}
