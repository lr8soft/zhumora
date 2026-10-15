import type { ChatMessage } from '../../shared/types.ts'
import { extractTextContent } from '../../shared/multimodal.ts'
import { assertContextFits } from './contextBudget.ts'
import { compactText } from './compactionText.ts'

export const SUMMARY_OUTPUT_TOKENS = 800
const SUMMARY_SYSTEM = 'You are a conversation summarizer. Preserve the task goal, decisions, file paths, important findings, completed work and unfinished next steps. Fold any prior [Auto Compact Summary] into the new summary. Source excerpts may omit large outputs; do not invent their contents. Output one concise paragraph without pleasantries.'
const SUMMARY_PREFIX = 'Summarize this conversation history:\n\n'

function formatMessage(message: ChatMessage): string {
  let text = `[${message.role}]${message.name ? ` (${message.name})` : ''}: `
  const content = extractTextContent(message.content)
  text += compactText(content, message.role === 'tool' ? 2000 : 4000)
  if (Array.isArray(message.content)) {
    const images = message.content.filter(part => part.type === 'image_url').length
    if (images) text += ` [${images} image(s)]`
  }
  if (message.tool_calls?.length) {
    const calls = message.tool_calls.slice(0, 20).map(call => `${call.function.name}(${compactText(call.function.arguments, 256)})`)
    text += ` [Tool calls: ${calls.join(', ')}${message.tool_calls.length > 20 ? '; more calls omitted' : ''}]`
  }
  return compactText(text, 6000) + '\n\n'
}

/** Aggregate bound, not merely a per-message limit. Buffers never grow with full history size. */
export function buildSummaryMessages(messages: ChatMessage[], contextWindow: number): ChatMessage[] {
  const base: ChatMessage[] = [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: SUMMARY_PREFIX }]
  const fixed = assertContextFits(base, contextWindow, [], SUMMARY_OUTPUT_TOKENS)
  // One character can be roughly one CJK token; stay conservative even when excerpts contain mostly ASCII.
  const maxChars = Math.max(0, Math.min(64_000, Math.floor((fixed.inputBudget - fixed.estimatedRequestTokens) / 1.2) - 256))
  const half = Math.floor(maxChars / 2)
  let head = ''; let tail = ''; let total = 0
  for (const message of messages) {
    const text = formatMessage(message)
    total += text.length
    if (head.length < half) head += text.slice(0, half - head.length)
    tail = half > 0 ? (tail + text).slice(-half) : ''
  }
  if (/[\uD800-\uDBFF]/.test(head.at(-1) || '')) head = head.slice(0, -1)
  if (/[\uDC00-\uDFFF]/.test(tail[0] || '')) tail = tail.slice(1)
  const source = total <= head.length + tail.length
    ? head + tail.slice(Math.max(0, head.length + tail.length - total))
    : `${head}\n[Middle history excerpts omitted to fit summary request budget.]\n${tail}`
  base[1] = { role: 'user', content: SUMMARY_PREFIX + source }
  // No summary HTTP may be sent if even the fixed prompt/output reserve cannot fit.
  assertContextFits(base, contextWindow, [], SUMMARY_OUTPUT_TOKENS)
  return base
}
