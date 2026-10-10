import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { UIMessage } from '../../../shared/types'
import { useAppStore } from '../store'
import { buildConversationGraph } from './buildGraph'
import { collectDelegations, splitConversationTurns, toolNodeId } from './history'

const EMPTY_MESSAGES: UIMessage[] = []

export function useFlowGraph(sessionId: string, foldHistory: boolean, expandedTurns: ReadonlySet<string>, showChildren: boolean) {
  const messages = useAppStore(state => state.messages[sessionId] ?? EMPTY_MESSAGES)
  const family = useAppStore(useShallow(state => state.sessions.filter(session => session.id === sessionId || session.subagent?.parentSessionId === sessionId)))
  const turns = useMemo(() => splitConversationTurns(messages), [messages])
  const collapsedTurns = useMemo(() => new Set(foldHistory
    ? turns.slice(0, -1).filter(turn => !expandedTurns.has(turn.id)).map(turn => turn.id) : []), [turns, foldHistory, expandedTurns])
  const sessions = useMemo(() => {
    const visibleCalls = new Set(turns.filter(turn => !collapsedTurns.has(turn.id))
      .flatMap(turn => turn.messages.flatMap(message => message.toolCalls?.map(call => toolNodeId(sessionId, call.id, message.id)) ?? [])))
    const referenced = collectDelegations(sessionId, messages, family, {})
    const children = new Set([...referenced.values()].filter(item => visibleCalls.has(item.nodeId)).map(item => item.session.id))
    return family.filter(session => session.id === sessionId || children.has(session.id))
  }, [family, turns, collapsedTurns, sessionId, messages])
  const idKey = JSON.stringify([sessionId, ...sessions.filter(session => session.id !== sessionId).map(session => session.id)])
  const ids = useMemo<string[]>(() => JSON.parse(idKey), [idKey])
  // Shallow selections subscribe only to this visible graph's authoritative message references.
  const histories = useAppStore(useShallow(state => Object.fromEntries(ids.map(id => [id, state.messages[id] ?? EMPTY_MESSAGES]))))
  const running = useAppStore(useShallow(state => ids.filter(id => state.runningIds.has(id))))
  const permissions = useAppStore(useShallow(state => ids.filter(id => !!state.permissionRequests[id])))
  const retries = useAppStore(useShallow(state => Object.fromEntries(ids.map(id => [id, state.retryStatus[id]]))))
  const compaction = useAppStore(state => state.compactionMarkers[sessionId])
  const loadMessages = useAppStore(state => state.loadMessages)
  const [loadError, setLoadError] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let current = true
    setLoadError(false)
    const needed = ids.filter(id => useAppStore.getState().messages[id] === undefined)
    void Promise.allSettled(needed.map(id => loadMessages(id))).then(results => {
      if (current) setLoadError(results.some(result => result.status === 'rejected'))
    })
    return () => { current = false }
  }, [ids, loadMessages, reload])

  const graph = useMemo(() => {
    const projection = buildConversationGraph({ sessionId, sessions, messages: histories,
      runningIds: new Set(running), collapsedTurns, showChildren, compaction })
    const awaiting = new Set(permissions)
    for (const node of projection.nodes) {
      if (node.data.kind === 'lane') node.data.awaitingPermission = awaiting.has(node.data.sessionId)
      node.data.retry = retries[node.data.sessionId]
    }
    return projection
  }, [sessionId, sessions, histories, running, collapsedTurns, showChildren, compaction, permissions, retries])

  return { graph, running, permissions, loadError, retryLoad: () => setReload(value => value + 1),
    loading: ids.some(id => useAppStore.getState().messages[id] === undefined) }
}
