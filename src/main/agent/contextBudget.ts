import type { ChatMessage, ToolDefinition } from '../../shared/types'

/** 可用输入占比（为本轮输出预留空间） */
const CONTEXT_WINDOW_INPUT_RATIO = 0.9
/** 相对可用输入预算的自动压缩触发比例 */
const COMPACTION_TRIGGER_RATIO = 0.9
/** 本地估算无法完全复现各模型 tokenizer，给代码/JSON/模板开销留余量。 */
const TOKEN_ESTIMATE_SAFETY_FACTOR = 1.2
const DEFAULT_PRESERVE_RECENT_TOKENS = 20_000

const CJK_REGEX = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f]/g

function estimateTextTokens(text: string): number {
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
  if (msg.content) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') {
          tokens += estimateTextTokens(part.text)
        } else if (part.type === 'image_url') {
          const url = part.image_url?.url || ''
          const b64Start = url.indexOf('base64,')
          const b64 = b64Start >= 0 ? url.length - b64Start - 7 : url.length
          tokens += Math.ceil(b64 / 24)
        }
      }
    } else {
      tokens += estimateTextTokens(msg.content)
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTextTokens(tc.function.name) + estimateTextTokens(tc.function.arguments) + 5
    }
  }
  if (msg.name) tokens += estimateTextTokens(msg.name)
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
}

/**
 * Estimate the complete request rather than only chat messages. Tool schemas are
 * serialized into every tool-enabled request and were the major missing term in
 * the previous budget check.
 */
export function measureContextBudget(
  messages: ChatMessage[],
  contextWindow: number,
  tools: ToolDefinition[] = []
): ContextBudgetUsage {
  const messageTokens = estimateTokens(messages)
  const toolDefinitionTokens = tools.length > 0
    ? estimateTextTokens(JSON.stringify(tools))
    : 0
  return {
    messageTokens,
    toolDefinitionTokens,
    estimatedRequestTokens: Math.ceil((messageTokens + toolDefinitionTokens) * TOKEN_ESTIMATE_SAFETY_FACTOR),
    threshold: getCompactThreshold(contextWindow)
  }
}

export function needsCompact(
  messages: ChatMessage[],
  contextWindow: number,
  tools: ToolDefinition[] = []
): boolean {
  const usage = measureContextBudget(messages, contextWindow, tools)
  return usage.estimatedRequestTokens >= usage.threshold
}
