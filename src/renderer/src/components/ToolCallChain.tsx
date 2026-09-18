import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { XCircle } from 'lucide-react'

import type { ToolChainNode, ToolChainTimelineRow } from '../timeline'

interface Props {
  row: ToolChainTimelineRow
}

function toolStatusClass(status?: 'done' | 'error'): string {
  return status === 'done' ? 'done' : status === 'error' ? 'error' : 'running'
}

function toolStatusLabel(t: (key: string) => string, status?: 'done' | 'error'): string {
  return status === 'done'
    ? t('chat.tool.done')
    : status === 'error'
      ? t('chat.tool.error')
      : t('chat.tool.running')
}

/** 参数 + 返回信息的展开体，链详情面板使用。 */
function ToolCallBody({ argumentsText, result }: {
  argumentsText?: string
  result?: { content: string; isError: boolean }
}) {
  const { t } = useTranslation()
  return (
    <div className="tool-call-body">
      {argumentsText && (
        <>
          <div className="tool-call-section-label">{t('chat.tool.args')}</div>
          <pre className="tool-call-pre">{argumentsText}</pre>
        </>
      )}
      {result && (
        <>
          <div className={`tool-call-section-label ${result.isError ? 'error' : ''}`}>
            {result.isError ? t('chat.tool.error') : t('chat.tool.result')}
          </div>
          <pre className="tool-call-pre">{result.content}</pre>
        </>
      )}
    </div>
  )
}

/**
 * 工具调用链条（横向节点行 + 链下固定详情面板）。
 * - 节点状态点：running=闪烁警告色 / done=绿 / error=红
 * - 默认横向滚动跟随最新节点（最右）；用户左翻后新节点不强制抢回位置
 * - 点击节点在链下方固定详情面板中显示该次调用的参数 + 返回信息
 * 展开态、选中节点、横向滚动位置都是组件的短生命周期 UI 状态，不进 store。
 *
 * 两个使用方：
 * 1. 跨轮工具链行（ToolCallChain，timeline 投影的 ToolChainTimelineRow）；
 * 2. 单条 assistant 消息内的并行 tool_calls（MessageBubble 直接渲染）。
 */
export function ToolCallChainView({ nodes }: { nodes: ToolChainNode[] }) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atEnd, setAtEnd] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)

  const last = nodes.length - 1
  // 选中节点被上游历史更新移除后回退到空（不显示详情面板）
  const selected = selectedIndex !== null && selectedIndex <= last ? selectedIndex : null
  const selectedNode: ToolChainNode | null = selected !== null ? nodes[selected] : null
  const nodeKey = (node: ToolChainNode) => `${node.toolCallId}:${node.name}`

  // 新节点出现且用户仍在最右 → 平滑滚到最右（"调用非常长时显示最新的"）
  const nodeCount = nodes.length
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !atEnd) return
    el.scrollTo({ left: el.scrollWidth, behavior: nodeCount <= 1 ? 'auto' : 'smooth' })
  }, [nodeCount, atEnd])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 8)
  }, [])

  const handleNodeClick = (index: number) => {
    setSelectedIndex(current => (current === index ? null : index))
  }

  return (
    <>
      <div className="tool-chain">
        <div className="tool-chain-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="tool-chain-nodes">
            {nodes.map((node, index) => {
              const statusClass = toolStatusClass(node.status)
              return (
                <button
                  key={nodeKey(node)}
                  type="button"
                  className={`tool-chain-node ${statusClass}${selected === index ? ' selected' : ''}`}
                  title={`${node.name} · ${toolStatusLabel(t, node.status)}`}
                  onClick={() => handleNodeClick(index)}
                >
                  <span className="dot" />
                  <span className="tool-chain-node-name">{node.name}</span>
                  {node.status === 'error' && <XCircle size={11} className="tool-chain-node-error" />}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      {selectedNode && (
        <div className="tool-chain-detail">
          <div className="tool-chain-detail-header">
            <span className="tool-chain-node-name full">{selectedNode.name}</span>
            <span className={`tool-call-status ${toolStatusClass(selectedNode.status)}`}>
              {selectedNode.status === 'error' && <XCircle size={11} />}
              {toolStatusLabel(t, selectedNode.status)}
            </span>
          </div>
          <ToolCallBody
            argumentsText={selectedNode.arguments}
            result={selectedNode.status === 'running' ? undefined : { content: selectedNode.content || '', isError: !!selectedNode.isError }}
          />
        </div>
      )}
    </>
  )
}

/** timeline 链行包装：memo 按 key（首个成员 id，稳定）+ revision（节点状态/成员变化）比较 */
function ToolCallChain({ row }: Props) {
  return <ToolCallChainView nodes={row.nodes} />
}

export default React.memo(ToolCallChain, (previous, next) =>
  previous.row.key === next.row.key && previous.row.revision === next.row.revision
)
