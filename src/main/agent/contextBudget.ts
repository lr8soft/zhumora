import type { ChatMessage, ToolDefinition } from '../../shared/types'

/** 可用输入占比（为本轮输出预留空间） */
const CONTEXT_WINDOW_INPUT_RATIO = 0.9
/** 相对可用输入预算的自动压缩触发比例 */
const COMPACTION_TRIGGER_RATIO = 0.9
/** 本地估算无法完全复现各模型 tokenizer，给代码/JSON/模板开销留余量。 */
const TOKEN_ESTIMATE_SAFETY_FACTOR = 1.2
const DEFAULT_PRESERVE_RECENT_TOKENS = 20_000
/**
 * 视觉模型对每张图的真实花费（OpenAI high-detail ≈765-1105、Qwen-VL ≈1k、
 * Claude ≈1.5k），取保守定额。绝不能按 base64 长度折算：一张 1MB 截图真实
 * 只花 ~1-2k tokens，按长度折会高估两个数量级，把本可发送的请求误判成超限。
 */
const VISION_TOKENS_PER_IMAGE = 2000

const CJK_REGEX = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f]/g

export function estimateTextTokens(text: string): number {
  const cjkCount = text.match(CJK_REGEX)?.length ?? 0
  const nonCjkChars = text.length - cjkCount
  return cjkCount + Math.ceil(nonCjkChars / 4)
}

export function getCompactThreshold(contextWindow: number): number {
  return Math.floor(contextWindow * CONTEXT_WINDOW_INPUT_RATIO * COMPACTION_TRIGGER_RATIO)
}

export function getPreserveTokenBudget(contextWindow: number): number {
  return Math.min(DEFAULT_PRESERVE_RECENT_TOKENS, Math.floor(contextWindow * 0.3))
}

export function estimateMessageTokens(msg: ChatMessage): number {
  let tokens = 4
  if (msg.reasoning) tokens += estimateTextTokens(msg.reasoning)
  if (msg.content) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          tokens += estimateTextTokens(part.text)
        } else if (part.type === 'image_url') {
          tokens += VISION_TOKENS_PER_IMAGE
        }
      }
    } else {
      tokens += estimateTextTokens(msg.content)
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTextTokens(tc.id) + estimateTextTokens(tc.function.name) + estimateTextTokens(tc.function.arguments) + 5
    }
  }
  if (msg.name) tokens += estimateTextTokens(msg.name)
  if (msg.tool_call_id) tokens += estimateTextTokens(msg.tool_call_id)
  return tokens
}

export function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

export interface ContextBudgetUsage {
  messageTokens: number
  toolDefinitionTokens: number
  estimatedRequestTokens: number
  threshold: number
  contextWindow: number
  inputBudget: number
  outputReserve: number
}

/**
 * Estimate the complete request rather than only chat messages. Tool schemas are
 * serialized into every tool-enabled request and were the major missing term in
 * the previous budget check.
 */
export function measureContextBudget(
  messages: ChatMessage[],
  contextWindow: number,
  tools: ToolDefinition[] = [],
  reservedOutputTokens?: number
): ContextBudgetUsage {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) throw new Error('Invalid context window')
  const outputReserve = reservedOutputTokens ?? Math.max(1, Math.ceil(contextWindow * (1 - CONTEXT_WINDOW_INPUT_RATIO)))
  if (!Number.isSafeInteger(outputReserve) || outputReserve < 0) throw new Error('Invalid output token reserve')
  const inputBudget = Math.max(0, Math.min(Math.floor(contextWindow * CONTEXT_WINDOW_INPUT_RATIO), contextWindow - outputReserve))
  const messageTokens = estimateTokens(messages)
  const toolDefinitionTokens = tools.length > 0
    ? estimateTextTokens(JSON.stringify(tools))
    : 0
  return {
    messageTokens,
    toolDefinitionTokens,
    estimatedRequestTokens: Math.ceil((messageTokens + toolDefinitionTokens) * TOKEN_ESTIMATE_SAFETY_FACTOR),
    threshold: Math.min(getCompactThreshold(contextWindow), Math.floor(inputBudget * COMPACTION_TRIGGER_RATIO)),
    contextWindow, inputBudget, outputReserve
  }
}

/** 拒发时点名最大的 token 贡献者，让"压缩后仍超限"能被定位而不是猜。 */
function largestContributors(messages: ChatMessage[]): string {
  const labeled = messages.map(message => {
    const label = message.role === 'tool' ? `tool(${message.name ?? message.tool_call_id ?? '?'})`
      : message.role === 'assistant' && message.tool_calls?.length ? `assistant(${message.tool_calls.map(call => call.function.name).join('+')})`
        : message.role === 'user' && Array.isArray(message.content) ? `user(${message.content.filter(part => part.type === 'image_url').length} image(s))`
          : message.role
    return { label, tokens: estimateMessageTokens(message) }
  }).filter(item => item.tokens > 512).sort((a, b) => b.tokens - a.tokens).slice(0, 3)
  return labeled.length ? ` Largest parts: ${labeled.map(item => `${item.label}≈${item.tokens} tokens`).join(', ')}.` : ''
}

export class ContextBudgetExceededError extends Error {
  readonly usage: ContextBudgetUsage

  constructor(usage: ContextBudgetUsage, details = '') {
    super(`Context remains too large after compaction: estimated input ${usage.estimatedRequestTokens} tokens exceeds input budget ${usage.inputBudget} (window ${usage.contextWindow}, output reserve ${usage.outputReserve}). Request was not sent. Reduce the input, system prompt or tool definitions, or start a new conversation.${details}`)
    this.name = 'ContextBudgetExceededError'
    this.usage = usage
  }
}

/** Every conversation request, including summaries and finalization, must pass this last check. */
export function assertContextFits(messages: ChatMessage[], contextWindow: number, tools: ToolDefinition[] = [], reservedOutputTokens?: number): ContextBudgetUsage {
  const usage = measureContextBudget(messages, contextWindow, tools, reservedOutputTokens)
  if (usage.estimatedRequestTokens > usage.inputBudget) {
    const details = tools.length > 0 && usage.toolDefinitionTokens * TOKEN_ESTIMATE_SAFETY_FACTOR > usage.inputBudget / 2
      ? ` Tool definitions alone consume ≈${usage.toolDefinitionTokens} tokens.`
      : largestContributors(messages)
    throw new ContextBudgetExceededError(usage, details)
  }
  return usage
}

export function needsCompact(
  messages: ChatMessage[],
  contextWindow: number,
  tools: ToolDefinition[] = []
): boolean {
  const usage = measureContextBudget(messages, contextWindow, tools)
  return usage.estimatedRequestTokens >= usage.threshold
}
