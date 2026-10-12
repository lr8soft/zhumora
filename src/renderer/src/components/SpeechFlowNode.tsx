import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import { Brain, Check, ChevronRight, LoaderCircle, MessageSquare, Wrench, XCircle } from 'lucide-react'
import { previewSteps, stepHandleId, type NestedStep } from '../flow/nestedSteps'
import type { FlowData, FlowDetailTab } from '../flow/types'

export type SpeechNodeData = FlowData & { onStepSelect?: (ownerId: string, stepId: string, tab?: FlowDetailTab) => void }

export default function SpeechFlowNode({ id, data, selected }: { id: string; data: SpeechNodeData; selected?: boolean }) {
  const { t } = useTranslation()
  const update = useUpdateNodeInternals()
  const { visible, hidden } = previewSteps(data)
  const ports = data.ports?.map(port => `${port.role}:${port.stepId}`).join('|') ?? ''
  const layout = visible.map(item => item.key).join('|')
  useEffect(() => { update(id) }, [id, ports, layout, update])
  const Status = data.status === 'done' ? Check : data.status === 'error' ? XCircle : data.status === 'running' ? LoaderCircle : null
  const words = data.message?.content?.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*|__|`/g, '').trim()
  return <div className={`flow-card flow-speech${selected ? ' is-selected' : ''}`}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <header><MessageSquare size={15} className="flow-card-icon" /><strong>{t('flow.kind.speech')}</strong>
      {Status && <Status size={13} className={`flow-node-status ${data.status}${data.status === 'running' ? ' spin' : ''}`} />}</header>
    <div className={`flow-speech-text${words ? '' : ' is-processing'}`}>{words || t('flow.processing')}</div>
    {visible.length > 0 && <div className="flow-inner-steps" aria-label={t('flow.stageSteps')}>
      {visible.map(item => <InnerStep key={item.key} ownerId={id} item={item} data={data} />)}
    </div>}
    {hidden > 0 && <button className="flow-inner-more nodrag nopan" onClick={event => {
      event.stopPropagation(); data.onStepSelect?.(id, data.steps![0].id)
    }}>{t('flow.moreSteps', { count: hidden })}<ChevronRight size={12} /></button>}
    <footer><span className={`flow-status ${data.status}`}>{t(`flow.status.${data.status}`)}</span>
      <span>{t('flow.executionCounts', { llm: data.llmCount, tools: data.toolCount })}<ChevronRight size={12} /></span></footer>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>
}

function InnerStep({ ownerId, item, data }: { ownerId: string; item: NestedStep; data: SpeechNodeData }) {
  const { t } = useTranslation()
  const Icon = item.kind === 'tool' ? Wrench : item.kind === 'thinking' ? Brain : LoaderCircle
  const label = item.kind === 'tool' ? item.step.data.title : t(item.kind === 'thinking' ? 'flow.thinking' : 'flow.waitingOutput')
  const roles = data.ports?.filter(port => port.stepId === item.step.id) ?? []
  return <button className={`flow-inner-step ${item.kind} ${item.step.data.status}${roles.length ? ' is-connected' : ''} nodrag nopan`} title={label}
    data-step-id={item.step.id} data-detail-tab={item.tab} onClick={event => {
      event.stopPropagation(); data.onStepSelect?.(ownerId, item.step.id, item.tab)
    }}>
    <Icon size={12} /><span>{label}</span>
    {item.step.data.status === 'running' ? <LoaderCircle size={10} className="spin" />
      : item.step.data.status === 'error' ? <XCircle size={10} /> : item.step.data.status === 'done' ? <Check size={10} /> : null}
    {roles.map(port => <Handle key={port.role} id={stepHandleId(port.role, item.step.id)} type={port.role}
      position={Position.Right} isConnectable={false} style={{ right: -16, top: roles.length > 1 ? port.role === 'source' ? '30%' : '70%' : '50%' }} />)}
  </button>
}
