import type { ChatMessage, ToolDefinition } from '../../shared/types.ts'
import { estimateTextTokens, estimateTokens, measureContextBudget, rawMessageAllowance } from './contextBudget.ts'
import { compactText, COMPACT_NOTICE_CHARS } from './compactionText.ts'

/** A cap is re-priced at most this often; each pass is one full projection. */
const MAX_PASSES = 9
/** Below this share an excerpt would be nothing but compactText's notice, so omit it. */
const EXCERPT_FLOOR = COMPACT_NOTICE_CHARS * 2
/** What a result whose share cannot hold an excerpt becomes. */
const OMITTED_MARKER = '[output projected]'

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

/**
 * Shrink one text to `cap` characters. `allowOmit` is set only where a recovery
 * pointer is guaranteed to follow: dropping a result to a marker without one would
 * delete it from the model's view for good. A call argument never qualifies — it has
 * to stay parseable JSON, since sanitizeHistory drops the whole call group otherwise.
 */
function projectText(text: string, cap: number, allowOmit: boolean): string {
  if (text.length <= cap) return text
  if (allowOmit && cap < EXCERPT_FLOOR) return OMITTED_MARKER
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
    // Nothing smaller to offer: an irreducible protocol stays byte-exact and the budget gate rejects it.
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
    const projected = projectText(args, cap, false)
    if (projected.length >= args.length) return call
    changed = true
    return { ...call, function: { ...call.function, arguments: projected } }
  })
  return changed ? { ...message, tool_calls: calls } : message
}

function projectMessage(message: ChatMessage, cap: number, allowOmit: boolean): ChatMessage {
  const withArgs = projectArguments(message, cap)
  if (withArgs.role !== 'tool') return withArgs
  // A string content that is itself the pointer holds nothing but the way back.
  if (typeof withArgs.content === 'string') return withArgs.toolOutputRef?.recoveryPart ? withArgs
    : { ...withArgs, content: projectText(withArgs.content, cap, allowOmit) }
  if (!Array.isArray(withArgs.content)) return withArgs
  const pointer = withArgs.toolOutputRef?.recoveryPart ? withArgs.content.length - 1 : -1
  return {
    ...withArgs,
    content: withArgs.content.map((part, index) => part.type !== 'text' || index === pointer
      ? part : { ...part, text: projectText(part.text, cap, allowOmit) })
  }
}

/**
 * Every text a projection may shorten: tool results and call arguments only. Prose,
 * system rules and image payloads are not ours to rewrite — compaction folds those
 * exchanges away instead, which is why the budget gate still rejects them. A recovery
 * pointer is excluded: it is a fixed cost, not a candidate for shrinking.
 */
function shrinkableTexts(messages: ChatMessage[]): string[] {
  const texts: string[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      const parts = Array.isArray(message.content)
        ? message.content.flatMap(part => part.type === 'text' ? [part.text] : [])
        : typeof message.content === 'string' ? [message.content] : []
      texts.push(...message.toolOutputRef?.recoveryPart ? parts.slice(0, -1) : parts)
    }
    for (const call of message.tool_calls ?? []) texts.push(call.function.arguments)
  }
  return texts
}

/**
 * Characters per token for this particular content. CJK is charged ~1 token/char and
 * ASCII ~4, so one fixed conversion would either cut English output four times harder
 * than needed or let CJK overflow the window it was sized for.
 */
function charsPerToken(texts: string[]): number {
  let chars = 0
  let tokens = 0
  for (const text of texts) { chars += text.length; tokens += estimateTextTokens(text) }
  return tokens > 0 ? Math.max(1, chars / tokens) : 4
}

/** Tokens left once every shrinkable text is removed: the projection cannot move those. */
function fixedTokens(messages: ChatMessage[]): number {
  const shrinkable = shrinkableTexts(messages).reduce((total, text) => total + estimateTextTokens(text), 0)
  return Math.max(0, estimateTokens(messages) - shrinkable)
}

/**
 * The largest per-unit token share with Σ min(unit, share) ≤ room: a unit already
 * shorter than the share hands its surplus to the ones still above it. Dividing room
 * by the unit count instead charges texts that are already short — one 200k result was
 * cut to 127 characters only because 150 small results were next to it.
 * `Infinity` means the room covers every unit as it stands.
 */
function shareTokens(sizes: number[], room: number): number {
  const sorted = [...sizes].sort((a, b) => b - a)
  const units = sorted.length
  if (!units) return Number.POSITIVE_INFINITY
  let total = 0
  for (const size of sorted) total += size
  if (room >= total) return Number.POSITIVE_INFINITY
  let untouched = total
  for (let capped = 1; capped <= units; capped++) {
    untouched -= sorted[capped - 1]
    const share = (room - untouched) / capped
    if (share <= sorted[capped - 1] && (capped === units || share >= sorted[capped])) return Math.max(0, share)
  }
  return 0
}

/**
 * Project tool results so the request fits its budget, sizing the cap by the room the
 * shrinkable texts actually share.
 *
 * A cap chosen per message without regard to how many there are floors the total at
 * `unitCount × floor`, so a fan-out of parallel calls could never compress enough — 60
 * results over a 16k window had no cap that fit and the run died at the budget gate.
 * `reservedTokens` holds back what the caller's recovery pointers will cost: without
 * it projection returns a request that fits and appending the pointers puts it back
 * over the line. Both are measured in the gate's own units, so the room here is the
 * room the last check will actually grant.
 *
 * No message is removed; tool_call_id, order and image attachments stay untouched.
 */
export function projectToolResultsToBudget(
  messages: ChatMessage[], contextWindow: number, tools: ToolDefinition[] = [], reservedTokens = 0
): ChatMessage[] {
  const initial = measureContextBudget(messages, contextWindow, tools)
  if (initial.estimatedRequestTokens < initial.threshold) return messages
  if (shrinkableTexts(messages).length === 0) return messages
  // Room reserved for recovery pointers is what authorizes omitting an excerpt entirely.
  const allowOmit = reservedTokens > 0
  let candidate = messages
  let cap = Number.POSITIVE_INFINITY
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const usage = measureContextBudget(candidate, contextWindow, tools)
    if (usage.estimatedRequestTokens < usage.threshold) return candidate
    const room = rawMessageAllowance(usage) - reservedTokens - fixedTokens(candidate)
    const texts = shrinkableTexts(candidate)
    let next = shareTokens(texts.map(text => estimateTextTokens(text)), room) * charsPerToken(texts)
    if (!Number.isFinite(cap) && !Number.isFinite(next)) break // every text already fits its share; only the gate decides
    if (Number.isFinite(cap)) {
      // Correct on measured cost rather than a fixed step. The pool is over its room by
      // a known factor (being here means it is), so scale the cap by that factor: a step
      // of /4 cut four times deeper than a near miss needed, and it keeps descending
      // while a projection refuses to shrink at all — a JSON result whose every field is
      // already short only responds to the omit level.
      const pool = texts.reduce((total, text) => total + estimateTextTokens(text), 0)
      next = Math.min(next, cap * Math.min(0.99, Math.max(0, room) / Math.max(1, pool)))
    }
    cap = Math.max(0, Math.min(cap, next))
    candidate = messages.map(message => projectMessage(message, cap, allowOmit))
    if (cap === 0) break // every unit is already a marker: there is nothing left to concede
  }
  return candidate
}
