import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { DEFAULT_SPEECH_SIZE, responsiveSpeechWidth } from './speechSizing'
import { finishGraphLayout } from './graphLayout'
import type { ConversationGraph } from './types'
import { previewSteps } from './nestedSteps'

export function useFlowSizing() {
  const fontSize = useAppStore(state => state.fontSize)
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(DEFAULT_SPEECH_SIZE.width)
  useEffect(() => {
    const owner = canvas?.ownerDocument.defaultView
    if (!canvas || !owner) return
    const observer = new owner.ResizeObserver(() => {
      if (canvas.clientWidth) setWidth(responsiveSpeechWidth(canvas.clientWidth))
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [canvas])
  return { setCanvas, sizing: useMemo(() => ({ width, fontSize }), [width, fontSize]) }
}

interface Measured { width: number; height: number; fontSize: number; content?: string; layout: string }

function layoutKey(node: ConversationGraph['nodes'][number]) {
  const { visible, hidden } = previewSteps(node.data)
  return JSON.stringify([visible.map(item => item.key), !!hidden, node.data.ports])
}

/** Cache is scoped to this workspace and current node IDs; offscreen changed text uses an estimate. */
export function useMeasuredFlowGraph(source: ConversationGraph, fontSize: number) {
  const cache = useRef(new Map<string, Measured>())
  const mounted = useRef(new Set<string>())
  const current = useRef({ source, fontSize })
  current.current = { source, fontSize }
  const [revision, setRevision] = useState(0)
  const onMount = useCallback((id: string, active: boolean) => {
    if (active) mounted.current.add(id)
    else mounted.current.delete(id)
  }, [])
  const onMeasure = useCallback((id: string, width: number, height: number) => {
    const { source, fontSize } = current.current
    const node = source.nodes.find(node => node.id === id)
    if (!node || !height || Math.abs(width - node.width) > 1) return
    const previous = cache.current.get(id)
    const next = { width, height, fontSize, content: node.data.message?.content, layout: layoutKey(node) }
    cache.current.set(id, next)
    if (!previous || previous.width !== width || previous.height !== height || previous.fontSize !== fontSize
      || (!mounted.current.has(id) && (previous.content !== next.content || previous.layout !== next.layout))) setRevision(value => value + 1)
  }, [])
  useEffect(() => {
    const ids = new Set(source.nodes.map(node => node.id))
    for (const id of cache.current.keys()) if (!ids.has(id)) cache.current.delete(id)
  }, [source])
  const graph = useMemo(() => {
    const heights = new Map<string, number>()
    for (const node of source.nodes) {
      const measure = cache.current.get(node.id)
      if (measure?.width === node.width && measure.fontSize === fontSize
        && (mounted.current.has(node.id) || (measure.content === node.data.message?.content && measure.layout === layoutKey(node)))) heights.set(node.id, measure.height)
    }
    const graph = { ...source, nodes: source.nodes.map(node => ({ ...node, position: { ...node.position } })) }
    finishGraphLayout(graph, heights, fontSize)
    return graph
  }, [source, revision, fontSize])
  return { graph, onMount, onMeasure }
}
