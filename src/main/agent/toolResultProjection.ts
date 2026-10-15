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

function projectMessage(message: ChatMessage, cap: number): ChatMessage {
  if (message.role !== 'tool') return message
  const content = typeof message.content === 'string' ? projectText(message.content, cap)
    : Array.isArray(message.content) ? message.content.map(part => part.type === 'text'
      ? { ...part, text: projectText(part.text, cap) } : part) : message.content
  return { ...message, content }
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
