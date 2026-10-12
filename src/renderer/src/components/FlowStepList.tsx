import { memo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, GitBranch, GitMerge, Wrench } from 'lucide-react'
import type { FlowStep } from '../flow/types'
import { flowTitle } from './ConversationFlowNode'

export default function FlowStepList({ steps, selectedId, onSelect }: {
  steps: readonly FlowStep[]; selectedId: string; onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const list = listRef.current
    const selected = list?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (!list || !selected) return
    const top = selected.offsetTop, bottom = top + selected.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [selectedId])

  return <div className="flow-stage-navigation">
    <div className="flow-stage-heading"><strong>{t('flow.stageSteps')}</strong><span>{t('flow.stageStepCount', { count: steps.length })}</span></div>
    <div className="flow-step-list" ref={listRef}>
      {steps.map((step, index) => <StepRow key={step.id} step={step} ordinal={index + 1} selected={selectedId === step.id} onSelect={onSelect} />)}
    </div>
  </div>
}

const StepRow = memo(function StepRow({ step, ordinal, selected, onSelect }: {
  step: FlowStep; ordinal: number; selected: boolean; onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  const Icon = step.data.kind === 'delegate' ? GitBranch : step.data.kind === 'join' ? GitMerge : step.data.call ? Wrench : Brain
  return <button aria-pressed={selected} onClick={() => onSelect(step.id)}>
    <span className="flow-step-number">{ordinal}</span><Icon size={12} /><span>{flowTitle(step.data, t)}</span>
    <small className={`flow-status ${step.data.status}`}>{t(`flow.status.${step.data.status}`)}</small>
  </button>
}, (previous, next) => previous.step.id === next.step.id && previous.ordinal === next.ordinal && previous.selected === next.selected
  && previous.onSelect === next.onSelect && previous.step.data.kind === next.step.data.kind
  && previous.step.data.title === next.step.data.title && previous.step.data.status === next.step.data.status)
