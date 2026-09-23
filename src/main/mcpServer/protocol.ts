import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { SERVER_INSTRUCTIONS } from '../../shared/mcpServer.ts'
import type { McpTaskActivity, McpTaskSnapshot, McpTaskStatus } from '../agent/taskProtocol.ts'
import { log } from '../llm/logger.ts'
import type { McpInboundService } from './service.ts'

const MAX_WAIT_MS = 10 * 60 * 1000
const DEFAULT_WAIT_MS = 60_000
const DEFAULT_CALLBACK_WAIT_MS = MAX_WAIT_MS
const MAX_PROGRESS_NOTIFICATIONS = 40
const MAX_PROGRESS_CHARS = 20_000

export function createMcpProtocolServer(
  options: ProtocolOptions,
  conversationKey: () => string
): McpServer {
  const server = new McpServer(
    { name: 'zhumora', version: '0.4.5' },
    { instructions: SERVER_INSTRUCTIONS }
  )

  registerDelegationPrompt(server)
  registerChatTool(server, options, conversationKey)
  registerWaitTool(server, options, conversationKey)
  registerPermissionTool(server, options, conversationKey)
  registerStatusTool(server, options, conversationKey)
  return server
}

function registerDelegationPrompt(server: McpServer): void {
  server.registerPrompt('delegate-to-zhumora', {
    title: 'Delegate a task to the Zhumora subagent',
    description: 'Hand a bounded task to Zhumora — the desktop agent on this Windows machine — and follow it through the mandatory completion callback.',
    argsSchema: {
      task: z.string().describe('The bounded task to delegate, including expected deliverable and relevant constraints.')
    }
  }, ({ task }) => ({
    description: 'Subagent delegation workflow with event-driven completion.',
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Delegate this task to Zhumora: ${task}`,
          'Zhumora runs on this Windows machine and can use shell, files, the browser, Windows GUI control, and Office documents — delegate to it instead of doing the work yourself in a sandbox.',
          'Call zhumora_chat once with the deliverable and constraints spelled out. If it is nonterminal, call zhumora_wait with the returned task_id and cursor.',
          'Keep zhumora_wait pending for the completion callback; do not create a timer polling loop and do not resend the task.',
          'Handle externally decidable permissions with zhumora_respond, otherwise wait for the human in Zhumora.',
          'Only report completion after Zhumora returns completed, failed, or aborted.'
        ].join('\n')
      }
    }]
  }))
}

function registerChatTool(
  server: McpServer,
  options: ProtocolOptions,
  conversationKey: () => string
): void {
  server.registerTool('zhumora_chat', {
    title: 'Delegate task to Zhumora subagent',
    description: [
      'PRIMARY SUBAGENT ENTRYPOINT: delegate one bounded task to Zhumora, a full desktop agent running on the SAME Windows machine (shell, files, browser, Windows GUI control, Office documents).',
      'Use it proactively whenever the work needs the real machine rather than your own sandbox: GUI or installed applications, files outside your working directory,',
      'the user\'s own browser profile, long unattended execution, or Office/document deliverables. Prefer delegating over re-implementing that work yourself or telling the user to run it.',
      'Typical tasks: open a settings dialog in an installed Windows app and change a value; operate the user\'s own browser session; run a build or a long script unattended;',
      'produce a .docx/.xlsx/.pptx/.pdf deliverable; read or edit files outside your working directory.',
      'Do not use it for documentation lookups, general code questions, or edits to files already in your working directory — do those yourself.',
      'Call this exactly once per task and state the expected deliverable plus constraints in message. If it returns running or awaiting_permission,',
      'you MUST call zhumora_wait with the returned task_id/cursor for the completion callback. Never resend the task and never',
      'timer-poll zhumora_status. Only completed/failed/aborted is a terminal answer: a running or awaiting_permission response is not completion.'
    ].join(' '),
    inputSchema: {
      message: z.string().describe(
        'The task to delegate. State the expected deliverable, constraints, and any absolute paths or context Zhumora needs to act without asking.'
      ),
      wait_ms: z.number().finite().optional().describe(
        `Maximum time to wait in milliseconds (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}). 0 returns immediately.`
      )
    }
  }, async ({ message, wait_ms }, extra) => {
    const key = conversationKey()
    const progress = createProgressReporter(extra, false)
    try {
      const status = await options.service.chat(
        key, message, clampWait(wait_ms, DEFAULT_WAIT_MS), progress.listener
      )
      return toToolResult(options, status, options.service.snapshot(key), status.status !== 'completed')
    } finally {
      await progress.drain()
    }
  })
}

function registerWaitTool(
  server: McpServer,
  options: ProtocolOptions,
  conversationKey: () => string
): void {
  server.registerTool('zhumora_wait', {
    title: 'Wait for Zhumora task completion',
    description: [
      'MANDATORY COMPLETION CALLBACK after zhumora_chat returns a nonterminal status.',
      'This is an event-driven blocking wait, not a status poll. By default it remains pending',
      'until the task completes, fails, aborts, needs permission, or reaches the bounded timeout.',
      'While pending, MCP progress notifications expose bounded live assistant/tool activity.',
      'Pass the returned cursor into any continuation so activity is not repeated.'
    ].join(' '),
    inputSchema: {
      task_id: z.string().describe('task_id returned by zhumora_chat.'),
      after_cursor: z.number().int().min(0).default(0).describe('Last cursor already consumed.'),
      wait_ms: z.number().finite().optional().describe(
        `Blocking wait in milliseconds (default and max ${DEFAULT_CALLBACK_WAIT_MS}).`
      ),
      return_on: z.enum(['terminal', 'update']).default('terminal').describe(
        'terminal waits for completion/permission; update returns on the next activity event.'
      ),
      include_reasoning: z.boolean().default(false).describe('Include bounded reasoning deltas in progress/results.'),
      max_events: z.number().int().min(1).max(80).default(24),
      max_chars: z.number().int().min(4000).max(50_000).default(12_000)
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ task_id, after_cursor, wait_ms, return_on, include_reasoning, max_events, max_chars }, extra) => {
    const progress = createProgressReporter(extra, include_reasoning)
    try {
      const snapshot = await options.service.waitForTask(
        conversationKey(), task_id, after_cursor, clampWait(wait_ms, DEFAULT_CALLBACK_WAIT_MS),
        return_on,
        { includeReasoning: include_reasoning, maxEvents: max_events, maxChars: max_chars },
        progress.listener
      )
      return toToolResult(options, snapshot.status, snapshot, true)
    } catch (error) {
      return toolError(safeError(error))
    } finally {
      await progress.drain()
    }
  })
}

function registerPermissionTool(
  server: McpServer,
  options: ProtocolOptions,
  conversationKey: () => string
): void {
  server.registerTool('zhumora_respond', {
    description: [
      'Approve or deny a pending Zhumora permission request when the task result reports',
      'decidable_by_you=true — when in doubt, approve so the task keeps moving. Other requests',
      'must be decided by the human in the Zhumora UI.'
    ].join(' '),
    inputSchema: {
      permission_id: z.string(),
      allow: z.boolean(),
      reason: z.string().optional().describe('Short justification recorded in Zhumora logs.')
    }
  }, async ({ permission_id, allow, reason }) => {
    const key = conversationKey()
    const status = options.service.respond(key, permission_id, allow, reason)
    return toToolResult(options, status, options.service.snapshot(key), false)
  })
}

function registerStatusTool(
  server: McpServer,
  options: ProtocolOptions,
  conversationKey: () => string
): void {
  server.registerTool('zhumora_status', {
    title: 'Get an instantaneous Zhumora task snapshot',
    description: 'Compatibility/diagnostic snapshot only. Do not timer-poll this tool; use zhumora_wait for event-driven completion.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => {
    const key = conversationKey()
    return toToolResult(options, options.service.status(key), options.service.snapshot(key), false)
  })
}

interface ProtocolOptions {
  service: McpInboundService
}

function toToolResult(
  options: ProtocolOptions,
  status: McpTaskStatus,
  snapshot: McpTaskSnapshot | null,
  includeActivities: boolean
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const canDecide = status.status === 'awaiting_permission'
    ? options.service.canExternalDecide(status.permission)
    : false
  const decoratedStatus = status.status === 'awaiting_permission'
    ? {
        ...status,
        decidable_by_you: canDecide,
        guidance: canDecide
          ? 'You may call zhumora_respond with this permission_id.'
          : 'This decision requires the human user in the Zhumora desktop UI. After asking them to decide, call zhumora_wait again.'
      }
    : status
  const payload = {
    ...(snapshot ? {
      task_id: snapshot.taskId,
      cursor: snapshot.cursor,
      ...(includeActivities ? {
        activities: snapshot.activities,
        activities_dropped: snapshot.activitiesDropped,
        has_more_activities: snapshot.hasMoreActivities
      } : {})
    } : {}),
    ...decoratedStatus,
    next_action: nextAction(status, canDecide)
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: status.status === 'failed' ? true : undefined
  }
}

function nextAction(status: McpTaskStatus, canDecide: boolean): string {
  if (status.status === 'running') {
    return 'Call zhumora_wait once with this task_id and cursor; keep it pending for the completion callback. Do not resend or timer-poll.'
  }
  if (status.status === 'awaiting_permission') {
    return canDecide
      ? 'Call zhumora_respond for this permission_id, then call zhumora_wait again for completion.'
      : 'Ask the human to decide in the Zhumora UI, then call zhumora_wait again. Do not report completion yet.'
  }
  if (status.status === 'completed') return 'Task completed. Use the reply as the subagent deliverable.'
  if (status.status === 'failed') return 'Task failed. Report the failure; do not claim success.'
  if (status.status === 'aborted') return 'Task was aborted. Report that it did not complete.'
  return 'No active task. Start one with zhumora_chat only when you have a concrete delegated task.'
}

function createProgressReporter(extra: {
  _meta?: { progressToken?: string | number }
  sendNotification(notification: {
    method: 'notifications/progress'
    params: { progressToken: string | number; progress: number; message?: string }
  }): Promise<void>
}, includeReasoning: boolean): { listener: (activity: McpTaskActivity) => void; drain: () => Promise<void> } {
  const progressToken = extra._meta?.progressToken
  let sequence = 0
  let sentChars = 0
  let suppressed = false
  let pending = Promise.resolve()
  const listener = (activity: McpTaskActivity): void => {
    if (progressToken === undefined || (activity.type === 'reasoning' && !includeReasoning)) return
    const message = formatProgressActivity(activity)
    const critical = activity.type === 'permission' || activity.type === 'completed'
      || activity.type === 'failed' || activity.type === 'aborted'
    if (!critical && (sequence >= MAX_PROGRESS_NOTIFICATIONS || sentChars + message.length > MAX_PROGRESS_CHARS)) {
      if (!suppressed) {
        suppressed = true
        enqueue('Further live details are suppressed to protect the caller context; the completion callback remains active.')
      }
      return
    }
    enqueue(message)
  }
  const enqueue = (message: string): void => {
    sentChars += message.length
    pending = pending.then(() => extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: progressToken!, progress: ++sequence, message }
    })).catch(error => log('warn', `MCP progress notification failed: ${safeError(error)}`))
  }
  return { listener, drain: () => pending }
}

function formatProgressActivity(activity: McpTaskActivity): string {
  switch (activity.type) {
    case 'assistant_output': return `Zhumora output: ${activity.text.slice(0, 800)}`
    case 'reasoning': return `Zhumora reasoning: ${activity.text.slice(0, 500)}`
    case 'tool_call': return `Zhumora is calling ${activity.toolName}.`
    case 'tool_result': return `Zhumora finished ${activity.toolName}${activity.isError ? ' with an error' : ''}: ${activity.content.slice(0, 500)}`
    case 'permission': return `Zhumora is awaiting permission for ${activity.permission.toolName}.`
    case 'retry': return `Zhumora is retrying (${activity.failedAttempt}/${activity.maxRetries}): ${activity.error}`
    case 'truncated': return `Zhumora detected truncated ${activity.kind} output (${activity.reason}).`
    case 'compaction': return `Zhumora compacted context from ${activity.beforeTokens} to ${activity.afterTokens} tokens.`
    case 'completed': return 'Zhumora task completed; final result follows.'
    case 'failed': return `Zhumora task failed: ${activity.error}`
    case 'aborted': return 'Zhumora task was aborted.'
  }
}

function clampWait(value: number | undefined, fallback: number): number {
  return Math.max(0, Math.min(value ?? fallback, MAX_WAIT_MS))
}

function toolError(error: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ status: 'failed', error }, null, 2) }], isError: true }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
}
