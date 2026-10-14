import type { FlowData, FlowDetailTab, FlowNode, FlowStep } from './types.ts'
import { primaryStep } from './nestedSteps.ts'

/** Follow execution within the stable speech container; queued calls have not run and cannot take focus. */
export function followedDetailStep(node: FlowNode): FlowStep {
  const steps = node.data.steps ?? []
  let latest: FlowStep | undefined
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]
    if (step.data.status === 'running') return step
    if (!latest && step.data.status !== 'queued' && step.data.status !== 'unresolved') latest = step
  }
  return latest ?? primaryStep(node)
}

export function defaultDetailTab(data: FlowData): FlowDetailTab {
  if (data.call) return data.result ? 'result' : 'args'
  return !data.message?.content && data.message?.reasoning ? 'reasoning' : 'content'
}
