import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Check, Copy, GitBranch, X } from 'lucide-react'
import type { FlowNode } from '../flow/types'
import { useAppStore } from '../store'
import MarkdownView from './MarkdownView'
import { flowTitle } from './ConversationFlowNode'

type DetailTab = 'content' | 'reasoning' | 'args' | 'result'

export default function FlowInspector({ node, onClose }: { node: FlowNode; onClose: () => void }) {
  const { t } = useTranslation()
  const sessions = useAppStore(state => state.sessions)
  const { data } = node
  const session = sessions.find(session => session.id === data.sessionId)
  const tabs: DetailTab[] = data.call ? ['args', 'result'] : ['content', ...(data.message?.reasoning ? ['reasoning' as const] : [])]
  const [tab, setTab] = useState<DetailTab>(data.result ? 'result' : tabs[0])
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const activeTab = tabs.includes(tab) ? tab : tabs[0]
  const text = activeTab === 'args' ? formatArguments(data.call?.function.arguments ?? '')
    : activeTab === 'result' ? data.result?.content ?? t('flow.noResult')
      : activeTab === 'reasoning' ? data.message?.reasoning ?? ''
        : data.message?.content ?? data.preview
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopyState('copied') }
    catch { setCopyState('error') }
  }
  const openSession = () => useAppStore.getState().setActiveSession(data.childSessionId ?? data.sessionId)
  return <aside className="flow-inspector" aria-label={t('flow.details')}>
    <header className="flow-inspector-header"><strong>{t('flow.details')}</strong>
      <button className="flow-icon-button" onClick={onClose} aria-label={t('flow.close')} title={t('flow.close')}><X size={16} /></button>
    </header>
    <div className="flow-inspector-summary"><span className={`flow-inspector-kind flow-${data.kind}`}>{t(`flow.kind.${data.kind}`)}</span>
      <h2>{flowTitle(data, t)}</h2><span className={`flow-status ${data.status}`}>{t(`flow.status.${data.status}`)}</span>
      <p>{session?.title}</p>
    </div>
    <div className="flow-detail-tabs" role="tablist" aria-label={t('flow.details')}>
      {tabs.map(key => <button key={key} role="tab" aria-selected={activeTab === key} className={activeTab === key ? 'active' : ''}
        onClick={() => { setTab(key); setCopyState('idle') }}>{t(`flow.tab.${key}`)}</button>)}
    </div>
    <div className="flow-detail-body" role="tabpanel">
      <div className="flow-detail-section"><span>{t(`flow.tab.${activeTab}`)}</span>
        <button className="flow-icon-button" onClick={() => void copy()} title={t(copyState === 'copied' ? 'flow.copied' : 'flow.copy')} aria-label={t('flow.copy')}>
          {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      {copyState === 'error' && <p className="flow-load-error" role="alert">{t('flow.copyError')}</p>}
      {activeTab === 'args' || activeTab === 'result' ? <pre className={data.result?.status === 'error' && activeTab === 'result' ? 'error' : ''}>{text}</pre>
        : <div className="markdown-body"><MarkdownView content={text || t('flow.noContent')} enableDiagrams={activeTab === 'content' && data.kind === 'llm'} /></div>}
      {activeTab === 'content' && data.message?.images?.length ? <div className="flow-detail-images">
        {data.message.images.map((src, index) => <img key={index} src={src} alt={t('chat.attachImage')} />)}
      </div> : null}
      {session?.subagent && <div className="flow-detail-model"><GitBranch size={13} />{session.subagent.model}</div>}
    </div>
    <footer className="flow-inspector-footer"><button onClick={openSession}><ArrowUpRight size={14} />{t('flow.openSession')}</button>
      {data.sessionId !== useAppStore.getState().activeSessionId && useAppStore.getState().runningIds.has(data.sessionId)
        && <button className="danger" onClick={() => void window.api.agent.abort(data.sessionId)}>{t('chat.stop')}</button>}
    </footer>
  </aside>
}

function formatArguments(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2) }
  catch { return value }
}
