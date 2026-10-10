import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Archive, Brain, Check, ChevronRight, GitBranch, GitMerge, LoaderCircle, MessageSquare, UserRound, Wrench, XCircle } from 'lucide-react'
import type { FlowData } from '../flow/types'

export type ConversationNode = Node<FlowData, 'conversation'>
const icons = { user: UserRound, llm: Brain, tool: Wrench, delegate: GitBranch, join: GitMerge,
  summary: Archive, turn: MessageSquare, compaction: Archive, lane: GitBranch }

export function flowTitle(data: FlowData, t: (key: string) => string): string {
  return data.call ? data.title : data.kind === 'lane' ? data.title : data.title || t(`flow.kind.${data.kind}`)
}

function ConversationFlowNode({ data, selected }: NodeProps<ConversationNode>) {
  const { t } = useTranslation()
  const Icon = icons[data.kind]
  if (data.kind === 'lane') {
    return <div className="flow-lane">
      <div className="flow-lane-label"><GitBranch size={12} /><strong>{data.title}</strong><span>{data.preview}</span>
        <small className={data.awaitingPermission ? 'permission' : ''}>{data.awaitingPermission ? t('flow.awaitingPermission')
          : data.retry && data.status === 'running' ? t('chat.retrying', { attempt: data.retry.failedAttempt, max: data.retry.maxRetries < 0 ? '∞' : data.retry.maxRetries })
            : t(`flow.status.${data.status}`)}</small>
      </div>
    </div>
  }
  const StatusIcon = data.status === 'done' ? Check : data.status === 'error' ? XCircle : data.status === 'running' ? LoaderCircle : null
  const preview = data.retry && data.status === 'running' ? t('chat.retrying', { attempt: data.retry.failedAttempt, max: data.retry.maxRetries < 0 ? '∞' : data.retry.maxRetries })
    : data.totalTaskCount ? t('flow.receivedCount', { received: data.returnedTaskCount, total: data.totalTaskCount })
    : data.call && !data.result ? data.call.function.arguments : data.preview
  return <div className={`flow-card flow-${data.kind}${selected ? ' is-selected' : ''}`}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <header><span className="flow-card-icon"><Icon size={15} /></span><strong>{flowTitle(data, t)}</strong>
      {StatusIcon && <StatusIcon size={13} className={`flow-node-status ${data.status}${data.status === 'running' ? ' spin' : ''}`} />}
    </header>
    <div className="flow-card-preview">{cardPreview(preview, data.kind) || t(data.kind === 'llm' ? 'flow.waitingOutput' : 'flow.noContent')}</div>
    <footer><span className={`flow-status ${data.status}`}>{t(`flow.status.${data.status}`)}</span>
      {data.kind === 'turn' ? <span>{t('flow.messageCount', { count: data.messageCount })}<ChevronRight size={12} /></span>
        : <span>{t(data.kind === 'delegate' ? 'flow.branch' : data.kind === 'join' ? 'flow.receive' : 'flow.inspect')}<ChevronRight size={12} /></span>}
    </footer>
    <Handle type="source" position={Position.Right} isConnectable={false} />
    {data.kind === 'delegate' && <Handle id="branch" type="source" position={Position.Bottom} isConnectable={false} />}
    {data.kind === 'join' && <Handle id="return" type="target" position={Position.Bottom} isConnectable={false} />}
  </div>
}

function cardPreview(text: string, kind: FlowData['kind']): string {
  const excerpt = text.slice(0, 220)
  return ['llm', 'user', 'turn', 'summary'].includes(kind)
    ? excerpt.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim() : excerpt
}

export default memo(ConversationFlowNode, (previous, next) => {
  const a = previous.data, b = next.data
  return previous.selected === next.selected && a.kind === b.kind && a.title === b.title && a.preview === b.preview
    && a.status === b.status && a.message === b.message && a.result === b.result && a.call === b.call
    && a.messageCount === b.messageCount && a.awaitingPermission === b.awaitingPermission
    && a.returnedTaskCount === b.returnedTaskCount && a.totalTaskCount === b.totalTaskCount
    && a.retry === b.retry
})
