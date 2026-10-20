import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import { Check, ChevronRight, LoaderCircle, MessageSquare, XCircle } from 'lucide-react'
import { previewSteps } from '../flow/nestedSteps'
import type { FlowData, FlowDetailTab } from '../flow/types'
import { useDetailAutoScroll } from '../flow/useDetailAutoScroll'
import { useSpeechMeasure, type SpeechMeasure } from '../flow/useSpeechMeasure'
import SpeechSteps from './SpeechSteps'
import { retryMessageKey } from '../../../shared/agentRetry'

export type SpeechNodeData = FlowData & SpeechMeasure & { onStepSelect?: (ownerId: string, stepId: string, tab?: FlowDetailTab) => void }

export default function SpeechFlowNode({ id, data, selected }: { id: string; data: SpeechNodeData; selected?: boolean }) {
  const { t } = useTranslation()
  const update = useUpdateNodeInternals()
  const { visible, hidden } = previewSteps(data)
  const ports = data.ports?.map(port => `${port.role}:${port.stepId}`).join('|') ?? ''
  const layout = visible.map(item => item.key).join('|')
  useEffect(() => { update(id) }, [id, ports, layout, update])
  const Status = data.status === 'done' ? Check : data.status === 'error' ? XCircle : data.status === 'running' ? LoaderCircle : null
  const words = data.message?.content?.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*|__|`/g, '').trim()
  const cardRef = useSpeechMeasure(id, words ?? '', `${layout}:${ports}`, data)
  const textRef = useDetailAutoScroll(id, words ?? '', true)
  return <div ref={cardRef} className={`flow-card flow-speech${selected ? ' is-selected' : ''}`}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <header><MessageSquare size={15} className="flow-card-icon" /><strong>{t('flow.kind.speech')}</strong>
      {Status && <Status size={13} className={`flow-node-status ${data.status}${data.status === 'running' ? ' spin' : ''}`} />}</header>
    {data.retry && data.status === 'running' && <div className="flow-card-meta" role="status">
      {t(retryMessageKey(data.retry), { attempt: data.retry.failedAttempt, max: data.retry.maxRetries < 0 ? '∞' : data.retry.maxRetries })}
    </div>}
    <div ref={textRef} className={`flow-speech-text nowheel nopan${words ? '' : ' is-processing'}`}>
      <div>{words || t('flow.processing')}</div>
    </div>
    <SpeechSteps id={id} data={data} />
    {hidden > 0 && <button className="flow-inner-more nodrag nopan" onClick={event => {
      event.stopPropagation(); data.onStepSelect?.(id, data.steps![0].id)
    }}>{t('flow.moreSteps', { count: hidden })}<ChevronRight size={12} /></button>}
    <footer><span className={`flow-status ${data.status}`}>{data.message?.generation
      ? t('flow.generation.' + data.message.generation.status) : t(`flow.status.${data.status}`)}</span>
      <span>{t('flow.executionCounts', { llm: data.llmCount, tools: data.toolCount })}<ChevronRight size={12} /></span></footer>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>
}
