import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import { Brain, Check, LoaderCircle, Wrench, XCircle } from 'lucide-react'
import { previewSteps, stepHandleId, type NestedStep } from '../flow/nestedSteps'
import type { SpeechNodeData } from './SpeechFlowNode'

interface Port { stepId: string; role: 'source' | 'target'; top: number }

export default function SpeechSteps({ id, data }: { id: string; data: SpeechNodeData }) {
  const { t } = useTranslation()
  const update = useUpdateNodeInternals()
  const { visible } = previewSteps(data)
  const [area, setArea] = useState<HTMLDivElement | null>(null)
  const [ports, setPorts] = useState<Port[]>([])
  const layout = visible.map(item => item.key).join('|')
  // Row elements only change with the layout or the container; scrolling must not rescan the DOM.
  const rowsRef = useRef<{ layout: string; area: HTMLDivElement | null; rows: Map<string, HTMLElement> } | null>(null)
  const refresh = useCallback(() => {
    if (!area) return
    let cached = rowsRef.current
    if (!cached || cached.area !== area || cached.layout !== layout) {
      cached = { layout, area, rows: new Map([...area.querySelectorAll<HTMLElement>('[data-step-id]')].map(row => [row.dataset.stepId!, row])) }
      rowsRef.current = cached
    }
    const next = (data.ports ?? []).flatMap(port => {
      const row = cached!.rows.get(port.stepId)
      if (!row) return []
      const paired = data.ports!.some(other => other.stepId === port.stepId && other.role !== port.role)
      const offset = paired ? port.role === 'source' ? -4 : 4 : 0
      const top = Math.max(7, Math.min(area.clientHeight - 7, row.offsetTop + row.offsetHeight / 2 - area.scrollTop + offset))
      return [{ ...port, top }]
    })
    // Hidden rows keep exact tool handles, anchored to the nearest scroll boundary.
    setPorts(previous => samePorts(previous, next) ? previous : next)
  }, [area, layout, data.ports])
  useLayoutEffect(refresh, [refresh, layout])
  useEffect(() => {
    const owner = area?.ownerDocument.defaultView
    if (!area || !owner) return
    const observer = new owner.ResizeObserver(refresh)
    observer.observe(area)
    return () => observer.disconnect()
  }, [area, refresh])
  useEffect(() => {
    const owner = area?.ownerDocument.defaultView
    if (!area || !owner) return
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = owner.requestAnimationFrame(() => { frame = 0; refresh() })
    }
    area.addEventListener('scroll', onScroll, { passive: true })
    return () => { if (frame) owner.cancelAnimationFrame(frame); area.removeEventListener('scroll', onScroll) }
  }, [area, refresh])
  useEffect(() => { update(id) }, [id, ports, update])
  if (!visible.length) return null
  return <div className="flow-inner-region">
    <div className="flow-inner-steps nowheel nopan nodrag" ref={setArea} aria-label={t('flow.stageSteps')}>
      {visible.map(item => <InnerStep key={item.key} ownerId={id} item={item} data={data} />)}
    </div>
    {ports.map(port => <Handle key={`${port.role}:${port.stepId}`} id={stepHandleId(port.role, port.stepId)}
      className="flow-inner-port" type={port.role} position={Position.Right} isConnectable={false} style={{ right: -16, top: port.top }} />)}
  </div>
}

function samePorts(previous: Port[], next: Port[]): boolean {
  return previous.length === next.length && previous.every((port, index) =>
    port.stepId === next[index].stepId && port.role === next[index].role && port.top === next[index].top)
}

function InnerStep({ ownerId, item, data }: { ownerId: string; item: NestedStep; data: SpeechNodeData }) {
  const { t } = useTranslation()
  const Icon = item.kind === 'tool' ? Wrench : item.kind === 'thinking' ? Brain : LoaderCircle
  const label = item.kind === 'tool' ? item.step.data.title : t(item.kind === 'thinking' ? 'flow.thinking' : 'flow.waitingOutput')
  const connected = data.ports?.some(port => port.stepId === item.step.id)
  return <button className={`flow-inner-step ${item.kind} ${item.step.data.status}${connected ? ' is-connected' : ''} nodrag nopan`} title={label}
    data-step-id={item.step.id} data-detail-tab={item.tab} onClick={event => {
      event.stopPropagation(); data.onStepSelect?.(ownerId, item.step.id, item.tab)
    }}>
    <Icon size={12} /><span>{label}</span>
    {item.step.data.status === 'running' ? <LoaderCircle size={10} className="spin" />
      : item.step.data.status === 'error' ? <XCircle size={10} /> : item.step.data.status === 'done' ? <Check size={10} /> : null}
  </button>
}
