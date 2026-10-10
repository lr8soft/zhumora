import type { ToolCall, UIMessage } from '../../../shared/types.ts'

export type FlowKind = 'user' | 'llm' | 'tool' | 'delegate' | 'join' | 'summary' | 'turn' | 'compaction' | 'lane'
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
}

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
}

export interface ConversationGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
  latestNodeId?: string
  turnIds: string[]
  childCount: number
}

export const FLOW_SIZE = { width: 238, height: 144, column: 312, row: 208, top: 80, left: 48 } as const
