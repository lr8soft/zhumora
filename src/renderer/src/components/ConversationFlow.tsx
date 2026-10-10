import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Background, BackgroundVariant, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type OnNodesChange } from '@xyflow/react'
import { ArrowRight, Focus, GitBranch, Layers, LocateFixed, Maximize2, Minus, Plus, RotateCcw } from 'lucide-react'
import { useFlowGraph } from '../flow/useFlowGraph'
import type { FlowNode } from '../flow/types'
import ConversationFlowNode, { flowTitle, type ConversationNode } from './ConversationFlowNode'
import FlowInspector from './FlowInspector'
import EmptyConversationHero from './EmptyConversationHero'
import { useAppStore } from '../store'
import '@xyflow/react/dist/style.css'
import './conversationFlow.css'

const NODE_TYPES = { conversation: ConversationFlowNode }
const EDGE_COLORS = { sequence: 'var(--app-color-border-strong)', delegate: 'var(--app-color-info)', return: 'var(--app-color-success)' }
const MINIMAP_COLORS = { user: 'var(--app-color-primary)', llm: 'var(--app-color-info)', tool: 'var(--app-color-cyan)',
  delegate: 'var(--app-color-info)', join: 'var(--app-color-success)', summary: 'var(--app-color-text-mute)',
  turn: 'var(--app-color-text-mute)', compaction: 'var(--app-color-text-mute)', lane: 'transparent' }

export default memo(function ConversationFlow({ sessionId }: { sessionId: string }) {
  return <ReactFlowProvider><FlowWorkspace sessionId={sessionId} /></ReactFlowProvider>
})

function FlowWorkspace({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const [foldHistory, setFoldHistory] = useState(true)
  const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<string>>(new Set())
  const [showChildren, setShowChildren] = useState(true)
  const [follow, setFollow] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const { graph, running, permissions, loadError, retryLoad, loading } = useFlowGraph(sessionId, foldHistory, expandedTurns, showChildren)
  const flow = useReactFlow<ConversationNode, Edge>()
  const initialised = useRef(false)
  const workspacePath = useAppStore(state => state.sessions.find(session => session.id === sessionId)?.workspacePath || state.settings.workspacePath)
  const selected = graph.nodes.find(node => node.id === selectedId)
  const topology = graph.nodes.map(node => `${node.id}:${node.position.x}:${node.position.y}:${node.width}`).join('|')
  const latest = graph.nodes.find(node => node.id === graph.latestNodeId)

  const nodes = useMemo<ConversationNode[]>(() => graph.nodes.map(node => ({ ...node,
    type: 'conversation', selected: node.id === selectedId, selectable: node.data.kind !== 'lane',
    focusable: node.data.kind !== 'lane', draggable: false, connectable: false, zIndex: node.data.kind === 'lane' ? -1 : 1,
    style: { width: node.width, height: node.height }, ariaLabel: `${flowTitle(node.data, t)} · ${t(`flow.status.${node.data.status}`)}`
  })), [graph.nodes, selectedId, t])
  const edges = useMemo<Edge[]>(() => graph.edges.map(edge => ({ ...edge, type: 'smoothstep',
    sourceHandle: edge.kind === 'delegate' ? 'branch' : undefined,
    targetHandle: edge.kind === 'return' ? 'return' : undefined,
    selectable: false, focusable: false,
    style: { stroke: EDGE_COLORS[edge.kind], strokeWidth: edge.kind === 'sequence' ? 1.5 : 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLORS[edge.kind], width: 16, height: 16 }
  })), [graph.edges])

  const fitAll = useCallback(() => { void flow.fitView({ padding: .16, duration: 250, minZoom: .08, maxZoom: 1 }) }, [flow])
  const focusLatest = useCallback(() => {
    const root = graph.nodes.filter(node => node.data.sessionId === sessionId && node.data.kind !== 'lane').slice(-3)
    if (root.length) void flow.fitView({ nodes: root.map(node => ({ id: node.id })), padding: .22, duration: 250, maxZoom: 1 })
  }, [flow, graph.nodes, sessionId])
  const openLatest = () => {
    if (!latest) return
    setSelectedId(latest.id)
    // Let the inspector commit and the canvas ResizeObserver publish its new bounds before fitting.
    requestAnimationFrame(() => requestAnimationFrame(focusLatest))
  }

  useEffect(() => {
    if (!flow.viewportInitialized || !graph.nodes.length) return
    // Text deltas never relayout or move the camera; only structural changes can advance following.
    if (!initialised.current) {
      initialised.current = true
      if (graph.nodes.length < 16) fitAll()
      else focusLatest()
    } else if (follow) focusLatest()
    // The topology key deliberately excludes content and statuses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology, follow, flow.viewportInitialized])

  const selectNode = (_event: React.MouseEvent, node: ConversationNode) => {
    if (node.data.kind === 'turn' && node.data.turnId) {
      setExpandedTurns(previous => new Set([...previous, node.data.turnId!]))
      setFollow(false)
    } else setSelectedId(node.id)
  }
  const onNodesChange: OnNodesChange<ConversationNode> = changes => {
    const selection = changes.find(change => change.type === 'select' && change.selected)
    if (selection?.type === 'select') setSelectedId(selection.id)
  }

  return <section className="conversation-flow" aria-label={t('flow.title')}>
    <div className="flow-toolbar"><div className="flow-toolbar-title"><GitBranch size={16} /><strong>{t('flow.title')}</strong>
      <span>{t('flow.turnCount', { count: graph.turnIds.length })}</span></div>
      <div className="flow-toolbar-actions">
        <button onClick={() => { setFollow(false); fitAll() }} title={t('flow.fit')}><Maximize2 size={13} /><span>{t('flow.fit')}</span></button>
        <button aria-pressed={foldHistory} aria-label={t(foldHistory ? 'flow.expandHistory' : 'flow.foldHistory')} title={t(foldHistory ? 'flow.expandHistory' : 'flow.foldHistory')}
          onClick={() => { setFoldHistory(value => !value); setExpandedTurns(new Set()); setFollow(false) }}>
          <Layers size={13} /><span>{t(foldHistory ? 'flow.expandHistory' : 'flow.foldHistory')}</span></button>
        <button aria-pressed={showChildren} aria-label={t('flow.children')} title={t('flow.children')}
          onClick={() => { setShowChildren(value => !value); setFollow(false) }}><GitBranch size={13} /><span>{t('flow.children')}</span></button>
        <button className={follow ? 'active' : ''} aria-pressed={follow} aria-label={t('flow.follow')} title={t('flow.follow')}
          onClick={() => { setFollow(value => !value); if (!follow) focusLatest() }}>
          <LocateFixed size={13} /><span>{t('flow.follow')}</span></button>
      </div>
    </div>
    {loadError && <div className="flow-load-error" role="alert">{t('flow.loadError')}<button onClick={retryLoad}><RotateCcw size={12} />{t('flow.retry')}</button></div>}
    <div className={`flow-workspace${selected ? ' has-inspector' : ''}`}>
      <div className="flow-canvas">
        <ReactFlow<ConversationNode, Edge> nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodeClick={selectNode}
          onNodesChange={onNodesChange} onPaneClick={() => setSelectedId(null)}
          onMoveStart={event => { if (event) setFollow(false) }} onMove={(_event, viewport) => setZoom(viewport.zoom)}
          nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
          panOnScroll zoomOnDoubleClick={false} minZoom={.08} maxZoom={1.8} onlyRenderVisibleElements
          autoPanOnNodeFocus={false} proOptions={{ hideAttribution: true }}>
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--app-color-border)" />
          {graph.nodes.length > 0 && <MiniMap nodeColor={node => MINIMAP_COLORS[(node.data as FlowNode['data']).kind]}
            nodeStrokeWidth={0} maskColor="color-mix(in srgb, var(--app-color-bg) 65%, transparent)" pannable zoomable />}
        </ReactFlow>
        {!graph.nodes.length && <div className="flow-empty">{loading ? <span className="spinner" /> : <>
          <EmptyConversationHero workspacePath={workspacePath} /><div className="flow-empty-path"><UserStep />
            <ArrowRight size={16} /><span>{t('flow.kind.llm')}</span><ArrowRight size={16} /><span>{t('flow.kind.tool')}</span>
            <ArrowRight size={16} /><span>{t('flow.finalReply')}</span></div></>}</div>}
        {graph.nodes.length > 0 && <div className="flow-zoom-tools">
          <button className="flow-icon-button" onClick={() => { setFollow(false); void flow.zoomOut() }} aria-label={t('flow.zoomOut')} title={t('flow.zoomOut')}><Minus size={14} /></button>
          <span>{Math.round(zoom * 100)}%</span>
          <button className="flow-icon-button" onClick={() => { setFollow(false); void flow.zoomIn() }} aria-label={t('flow.zoomIn')} title={t('flow.zoomIn')}><Plus size={14} /></button>
          <button className="flow-icon-button" onClick={() => { setFollow(false); fitAll() }} aria-label={t('flow.fit')} title={t('flow.fit')}><Focus size={14} /></button>
        </div>}
      </div>
      {selected && <FlowInspector key={selected.id} node={selected} onClose={() => setSelectedId(null)} />}
    </div>
    <footer className="flow-statusbar"><div className="flow-legend"><span className="llm">{t('flow.kind.llm')}</span><span className="tool">{t('flow.kind.tool')}</span><span className="delegate">{t('flow.branch')}</span></div>
      <div className="flow-runtime-status">{permissions.length > 0 ? <span className="permission">{t('flow.awaitingPermission')}</span>
        : running.length > 0 ? <><span className="pulse-dot" />{latest?.data.retry ? t('chat.retrying', {
          attempt: latest.data.retry.failedAttempt, max: latest.data.retry.maxRetries < 0 ? '∞' : latest.data.retry.maxRetries
        }) : t('flow.running')}</> : <span>{t('flow.ready')}</span>}
        <span className="flow-count">{t('flow.stepCount', { count: graph.nodes.filter(node => node.data.kind !== 'lane').length })}</span>
        {latest && <button onClick={openLatest}><span>{t('flow.latest')}</span><ArrowRight size={12} /></button>}
      </div>
    </footer>
  </section>
}

function UserStep() { const { t } = useTranslation(); return <span>{t('flow.kind.user')}</span> }
