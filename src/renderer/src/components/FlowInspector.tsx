import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Check, Copy, GitBranch, X } from 'lucide-react'
import type { FlowData, FlowDetailFocus, FlowDetailTab as DetailTab, FlowNode } from '../flow/types'
import { primaryStep } from '../flow/nestedSteps'
import { useDetailAutoScroll } from '../flow/useDetailAutoScroll'
import { useAppStore } from '../store'
import MarkdownView from './MarkdownView'
import { flowTitle } from './ConversationFlowNode'
import FlowStepList from './FlowStepList'

export default function FlowInspector({ node, focus, onClose }: { node: FlowNode; focus?: FlowDetailFocus; onClose: () => void }) {
  const { t } = useTranslation()
  const sessions = useAppStore(state => state.sessions)
  const running = useAppStore(state => state.runningIds.has(node.data.sessionId))
  const { data } = node
  const session = sessions.find(session => session.id === data.sessionId)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(focus?.stepId ?? null)
  const detail = data.steps?.find(step => step.id === selectedStepId) ?? primaryStep(node)
  const value = detail.data
  const tabs: DetailTab[] = value.call ? ['args', 'result'] : ['content', ...(value.message?.reasoning ? ['reasoning' as const] : [])]
  const [tab, setTab] = useState<{ stepId: string; value: DetailTab } | null>(focus?.tab ? { stepId: focus.stepId, value: focus.tab } : null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  useEffect(() => {
    setSelectedStepId(focus?.stepId ?? null)
    setTab(focus?.tab ? { stepId: focus.stepId, value: focus.tab } : null)
    setCopyState('idle')
  }, [focus])
  const activeTab = tab?.stepId === detail.id && tabs.includes(tab.value) ? tab.value : defaultTab(value)
  const text = activeTab === 'args' ? formatArguments(value.call?.function.arguments ?? '')
    : activeTab === 'result' ? value.result?.content ?? t('flow.noResult')
      : activeTab === 'reasoning' ? value.message?.reasoning ?? ''
        : value.message?.content ?? value.preview
  const bodyRef = useDetailAutoScroll(`${detail.id}:${activeTab}`, text, running || value.status === 'running')
  const copy = async (owner: Window | null) => {
    try { await (owner ?? window).navigator.clipboard.writeText(text); setCopyState('copied') }
    catch { setCopyState('error') }
  }
  const selectStep = useCallback((id: string) => { setSelectedStepId(id); setTab(null); setCopyState('idle') }, [])
  const openSession = () => useAppStore.getState().setActiveSession(value.childSessionId ?? data.sessionId)
  return <aside className="flow-inspector" aria-label={t('flow.details')}>
    <header className="flow-inspector-header"><strong>{t('flow.details')}</strong>
      <button className="flow-icon-button" onClick={onClose} aria-label={t('flow.close')} title={t('flow.close')}><X size={16} /></button>
    </header>
    <div className="flow-inspector-summary"><span className={`flow-inspector-kind flow-${data.kind}`}>{t(`flow.kind.${data.kind}`)}</span>
      <h2>{flowTitle(data, t)}</h2><span className={`flow-status ${data.status}`}>{t(`flow.status.${data.status}`)}</span>
      <p>{session?.title}</p>
    </div>
    {data.steps && <FlowStepList steps={data.steps} selectedId={detail.id} onSelect={selectStep} />}
    <div className="flow-detail-tabs" role="tablist" aria-label={t('flow.details')}>
      {tabs.map(key => <button key={key} role="tab" aria-selected={activeTab === key} className={activeTab === key ? 'active' : ''}
        onClick={() => { setSelectedStepId(detail.id); setTab({ stepId: detail.id, value: key }); setCopyState('idle') }}>{t(`flow.tab.${key}`)}</button>)}
    </div>
    <div className="flow-detail-body" role="tabpanel" ref={bodyRef} tabIndex={0}>
      <div className="flow-detail-content">
      <div className="flow-detail-section"><span>{t(`flow.tab.${activeTab}`)}</span>
        <button className="flow-icon-button" onClick={event => void copy(event.currentTarget.ownerDocument.defaultView)} title={t(copyState === 'copied' ? 'flow.copied' : 'flow.copy')} aria-label={t('flow.copy')}>
          {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      {copyState === 'error' && <p className="flow-load-error" role="alert">{t('flow.copyError')}</p>}
      {activeTab === 'args' || activeTab === 'result' ? <pre className={value.result?.status === 'error' && activeTab === 'result' ? 'error' : ''}>{text}</pre>
        : <div className="markdown-body"><MarkdownView content={text || t('flow.noContent')} enableDiagrams={activeTab === 'content' && value.kind === 'llm'} /></div>}
      {activeTab === 'content' && value.message?.images?.length ? <div className="flow-detail-images">
        {value.message.images.map((src, index) => <img key={index} src={src} alt={t('chat.attachImage')} />)}
      </div> : null}
      {session?.subagent && <div className="flow-detail-model"><GitBranch size={13} />{session.subagent.model}</div>}
      </div>
    </div>
    <footer className="flow-inspector-footer"><button onClick={openSession}><ArrowUpRight size={14} />{t('flow.openSession')}</button>
      {data.sessionId !== useAppStore.getState().activeSessionId && useAppStore.getState().runningIds.has(data.sessionId)
        && <button className="danger" onClick={() => void window.api.agent.abort(data.sessionId)}>{t('chat.stop')}</button>}
    </footer>
  </aside>
}

function defaultTab(data: FlowData): DetailTab {
  if (data.call) return data.result ? 'result' : 'args'
  return !data.message?.content && data.message?.reasoning ? 'reasoning' : 'content'
}

function formatArguments(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2) }
  catch { return value }
}
