import type { ChatMessage, ToolDefinition } from '../../shared/types.ts'
import { measureContextBudget } from './contextBudget.ts'
import { compactText } from './compactionText.ts'

// A finite fallback for recent indivisible tool groups, never a provider/tool visibility policy.
const INITIAL_TEXT_CAP = 48_000
const MIN_TEXT_CAP = 256
const MAX_PASSES = 9

function projectJson(value: unknown, cap: number, key = '', depth = 0): unknown {
  if (depth > 32) return value
  // Keep correlation/routing fields intact even when an upstream protocol supplies a long ID.
  if (typeof value === 'string') return /(?:ids?|cursors?|status|state|paths?|urls?|names?)$/i.test(key) ? value : compactText(value, cap)
  if (Array.isArray(value)) return value.map(item => projectJson(item, cap, key, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, projectJson(item, cap, name, depth + 1)]))
  }
  return value
}

function projectText(text: string, cap: number): string {
  if (text.length <= cap) return text
  // Preserve JSON structure/types and short metadata rather than cutting a serialized protocol in half.
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return compactText(text, cap) }
  let safe = true
  try {
    const projected = JSON.stringify(projectJson(parsed, cap), (_key, value: unknown) => {
      // JSON.parse/stringify must not round a large integer identifier or convert an overflow to null.
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) safe = false
      return value
    })
    return safe && projected.length < text.length ? projected : text
  } catch (error) {
    if (error instanceof RangeError) return text // excessively deep JSON stays intact; the budget gate can reject it
    throw error
  }
}

/**
 * Call arguments (a write/edit payload can exceed the whole window) are re-sent on
 * every round and were the largest unprojectable contributor. Correlation rides on
 * tool_call_id, so shrinking valid JSON argument values keeps the protocol legal.
 * Non-JSON arguments stay byte-exact: sanitizeHistory already rejects broken ones.
 */
function projectArguments(message: ChatMessage, cap: number): ChatMessage {
  if (!message.tool_calls?.length) return message
  let changed = false
  const calls = message.tool_calls.map(call => {
    const args = call.function.arguments
    if (args.length <= cap) return call
    try { JSON.parse(args) } catch { return call }
    const projected = projectText(args, cap)
    if (projected.length >= args.length) return call
    changed = true
    return { ...call, function: { ...call.function, arguments: projected } }
  })
  return changed ? { ...message, tool_calls: calls } : message
}

function projectMessage(message: ChatMessage, cap: number): ChatMessage {
  const withArgs = projectArguments(message, cap)
  if (withArgs.role !== 'tool') return withArgs
  const content = typeof withArgs.content === 'string' ? projectText(withArgs.content, cap)
    : Array.isArray(withArgs.content) ? withArgs.content.map(part => part.type === 'text'
      ? { ...part, text: projectText(part.text, cap) } : part) : withArgs.content
  return { ...withArgs, content }
}

/** No message is removed; tool_call_id, order, call arguments and image attachments remain untouched. */
export function projectToolResultsToBudget(messages: ChatMessage[], contextWindow: number, tools: ToolDefinition[] = []): ChatMessage[] {
  const initial = measureContextBudget(messages, contextWindow, tools)
  if (initial.estimatedRequestTokens < initial.threshold) return messages
  let candidate = messages
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const cap = Math.max(MIN_TEXT_CAP, Math.floor(INITIAL_TEXT_CAP / 2 ** pass))
    candidate = messages.map(message => projectMessage(message, cap))
    const usage = measureContextBudget(candidate, contextWindow, tools)
    if (usage.estimatedRequestTokens < usage.threshold || cap === MIN_TEXT_CAP) break
  }
  return candidate
}
