import type { ToolCall, UIMessage } from '../../../shared/types.ts'

export type FlowKind = 'user' | 'llm' | 'tool' | 'speech' | 'delegate' | 'join' | 'summary' | 'turn' | 'compaction' | 'lane'
export type FlowStatus = 'done' | 'running' | 'queued' | 'error' | 'unresolved'

export interface FlowData extends Record<string, unknown> {
  kind: FlowKind
  sessionId: string
  title: string
  preview: string
  status: FlowStatus
  message?: UIMessage
  call?: ToolCall
  result?: UIMessage
  turnId?: string
  messageCount?: number
  childSessionId?: string
  taskId?: string
  returnedTaskCount?: number
  totalTaskCount?: number
  awaitingPermission?: boolean
  retry?: { failedAttempt: number; maxRetries: number }
  steps?: FlowStep[]
  toolCount?: number
  llmCount?: number
  ports?: { stepId: string; role: 'source' | 'target' }[]
  laneIndex?: number
}

export interface FlowStep { id: string; data: FlowData }
export type FlowDetailTab = 'content' | 'reasoning' | 'args' | 'result'
export interface FlowDetailFocus { stepId: string; tab?: FlowDetailTab }

export interface FlowNode {
  id: string
  data: FlowData
  position: { x: number; y: number }
  width: number
  height: number
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  kind: 'sequence' | 'delegate' | 'return'
  sourceStepId?: string
  targetStepId?: string
}

export interface ConversationGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
  latestNodeId?: string
  turnIds: string[]
  childCount: number
}

export const FLOW_SIZE = { width: 238, height: 144, column: 312, row: 208, top: 80, left: 48 } as const
export const FLOW_GAP = FLOW_SIZE.column - FLOW_SIZE.width
