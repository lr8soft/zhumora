import type { FlowData, FlowDetailTab, FlowNode, FlowStep } from './types.ts'

export interface NestedStep {
  key: string
  step: FlowStep
  kind: 'thinking' | 'tool' | 'waiting'
  tab: FlowDetailTab
}

export function nestedSteps(data: FlowData): NestedStep[] {
  return (data.steps ?? []).flatMap<NestedStep>(step => {
    if (step.data.call) return [{ key: step.id, step, kind: 'tool' as const, tab: step.data.result ? 'result' as const : 'args' as const }]
    if (step.data.message?.reasoning) return [{ key: `reasoning:${step.id}`, step, kind: 'thinking' as const, tab: 'reasoning' as const }]
    if (step.data.status === 'running' && !step.data.message?.content) return [{ key: `waiting:${step.id}`, step, kind: 'waiting' as const, tab: 'content' as const }]
    return []
  })
}

export function previewSteps(data: FlowData): { visible: NestedStep[]; hidden: number } {
  const all = nestedSteps(data)
  const connected = new Set(data.ports?.map(port => port.stepId) ?? [])
  const regular = new Set(all.filter(item => !connected.has(item.step.id)).slice(0, 6).map(item => item.key))
  const visible = all.filter(item => connected.has(item.step.id) || regular.has(item.key))
  return { visible, hidden: all.length - visible.length }
}

export function stepHandleId(role: 'source' | 'target', stepId: string): string {
  return `${role}:${stepId}`
}

/** Connected tool rows span both columns, leaving their side ports clear of other inner nodes. */
export function previewRowCount(data: FlowData, columns = 2): number {
  const connected = new Set(data.ports?.map(port => port.stepId) ?? [])
  let rows = 0, halfRow = false
  for (const item of previewSteps(data).visible) {
    if (columns === 1) { rows++; continue }
    if (connected.has(item.step.id)) { rows += halfRow ? 2 : 1; halfRow = false }
    else if (halfRow) { rows++; halfRow = false }
    else halfRow = true
  }
  return rows + (halfRow ? 1 : 0)
}

export function primaryStep(node: FlowNode): FlowStep {
  return node.data.steps?.find(step => !step.data.call && step.data.message?.id === node.data.message?.id)
    ?? node.data.steps?.at(-1) ?? { id: node.id, data: node.data }
}
