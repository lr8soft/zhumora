import { useCallback, useEffect, useState } from 'react'
import type { ConversationGraph, FlowDetailFocus } from './types'

interface Selection { id: string | null; focus?: FlowDetailFocus }

/** Details follow the main anchor; concurrent camera framing never switches between siblings. Closed details stay closed. */
export function useFlowSelection(graph: ConversationGraph, follow: boolean, stopFollowing: () => void) {
  const [selection, setSelection] = useState<Selection>({ id: null })
  const id = follow && selection.id !== null ? graph.latestNodeId ?? selection.id : selection.id
  const selected = graph.nodes.find(node => node.id === id && node.data.kind !== 'lane')
    ?? graph.nodes.find(node => node.data.steps?.some(step => step.id === id))

  useEffect(() => {
    if (follow && selection.id !== null && graph.latestNodeId
      && (selection.id !== graph.latestNodeId || selection.focus)) {
      // Remember the followed node so pausing does not resurrect an old selection.
      setSelection({ id: graph.latestNodeId })
    }
  }, [follow, graph.latestNodeId, selection.id, selection.focus])

  const select = useCallback((id: string, focus?: FlowDetailFocus) => {
    stopFollowing()
    setSelection({ id, focus })
  }, [stopFollowing])
  const selectStep = useCallback((_ownerId: string, stepId: string, tab?: FlowDetailFocus['tab']) => {
    select(stepId, { stepId, tab })
  }, [select])
  const close = useCallback(() => setSelection({ id: null }), [])
  const openLatest = () => { if (graph.latestNodeId) setSelection({ id: graph.latestNodeId }) }

  return { selected, detailFocus: follow ? undefined : selection.focus, select, selectStep, close, openLatest }
}
