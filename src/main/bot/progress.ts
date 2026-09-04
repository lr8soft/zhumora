import type { ToolCall } from '../../shared/types'

const TOOL_ARG_PREVIEW = 70

/** Platform-neutral, redacted-by-selection one-line tool activity label. */
export function formatBotToolCall(toolCall: ToolCall): string {
  const name = toolCall.function?.name || 'tool'
  const args = parseArgs(toolCall.function?.arguments)
  const hint = pickArgHint(args)
  return hint ? `${name}: ${hint}` : name
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

// Never display arbitrary arguments: only the small set useful as activity context.
const ARG_HINT_KEYS = ['command', 'file_path', 'url', 'query', 'pattern', 'text', 'title', 'name']
function pickArgHint(args: Record<string, unknown>): string {
  for (const key of ARG_HINT_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return preview(value)
  }
  return ''
}

function preview(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim()
  const characters = Array.from(single)
  return characters.length <= TOOL_ARG_PREVIEW
    ? single
    : characters.slice(0, TOOL_ARG_PREVIEW).join('') + '…'
}
