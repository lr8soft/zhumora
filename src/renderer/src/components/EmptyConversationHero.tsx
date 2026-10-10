import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

export default function EmptyConversationHero({ workspacePath }: { workspacePath?: string }) {
  const { t } = useTranslation()
  const title = useMemo(() => {
    const normalized = (workspacePath || '').replace(/[\\/]+$/, '')
    const name = normalized.split(/[\\/]/).filter(Boolean).pop()
    return name ? t('chat.heroPrompt', { workspace: name }) : t('app.name')
  }, [workspacePath, t])
  return <div className="chat-empty"><img className="empty-mark" src="./logo.png" alt="" /><h2>{title}</h2><p>{t('chat.welcomeHint')}</p></div>
}
