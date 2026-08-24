// ============================================================
// 系统提示词构建 — 从工具注册表动态生成工具描述
// ============================================================
import { getAllTools, getToolsBySource } from '../tools/registry'
import { getMcpConnectionStatus } from '../mcp/client'
import type { ToolDefinition } from '../../shared/types'

// ============================================================
// 静态指导文本（与具体工具列表无关的通用规则）
// ============================================================

const EDITING_RULES = `## Editing Rules (IMPORTANT)
1. **ALWAYS read a file before editing it.** Never use edit with a guessed oldString — if the oldString doesn't match, the edit will fail.
2. When editing, copy the exact text from the read output as oldString. Include enough surrounding context to make the match unique.
3. For large changes across many files, prefer bash with sed/awk or write the entire file.
4. If edit fails with "oldString not found", re-read the file to get the current content, then retry with the exact text.`

const SEARCH_STRATEGY = `## Search Strategy
1. When exploring an unfamiliar project: ls first, then glob for specific files, then read relevant files.
2. When searching for code: use grep with include to narrow scope (e.g. include="*.{h,cpp}" for C++). Use exclude to skip irrelevant directories (e.g. exclude=["node_modules", ".git", "Binaries"]).
3. When looking for a specific file: use glob with the filename pattern (e.g. **/*AuthManager*). Similarly use exclude to avoid searching build artifacts.
4. All glob/grep paths default to the workspace directory. You can specify a subdirectory as path to narrow the search.`

const MEMORY_GUIDE = `## Long-term Memory
You have access to a persistent memory system. You can proactively use these tools:
- memory_search: Search stored memories about the user's preferences, habits, facts, skills, and project context.
- memory_save: Save a new memory when you detect something worth remembering about the user.
- memory_list: List all stored memories or filter by category.
- memory_delete: Delete an outdated or incorrect memory (confirm with user first).

When to use memory tools:
- At the START of a conversation, proactively call memory_search with keywords from the user's message to check if you have relevant context.
- When the user mentions a preference, habit, or important context, call memory_save to store it.
- When the user asks "do you remember..." or refers to past conversations, use memory_search to find relevant memories.
- Do NOT save trivial information (e.g. "user said hello"). Only save durable, useful facts.`

const GUIDELINES = `## Guidelines
- If a task requires multiple steps, plan your approach first, then execute step by step.
- Always explain what you're doing and why, especially before running potentially impactful operations.
- If you're unsure about something, ask the user for clarification.
- IMPORTANT: At the start of every new conversation, you MUST call the set_title tool with a short title (max 6 words) that summarizes the user's request. Do this before doing anything else.`

// ============================================================
// 工具分类映射 — 将工具名映射到分类标签
// ============================================================

const TOOL_CATEGORIES: { label: string; tools: string[] }[] = [
  {
    label: 'Reading & Exploring',
    tools: ['read', 'ls', 'glob', 'grep']
  },
  {
    label: 'Writing & Editing',
    tools: ['write', 'edit', 'bash', 'set_title']
  },
  {
    label: 'Browser (Playwright)',
    tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot',
            'browser_get_text', 'browser_get_html', 'browser_wait', 'browser_close']
  },
  {
    label: 'Desktop Control',
    tools: ['desktop']
  },
  {
    label: 'Memory',
    tools: ['memory_search', 'memory_save', 'memory_list', 'memory_delete']
  },
  {
    label: 'MCP Server Management',
    tools: ['mcp_list_servers', 'mcp_add_server', 'mcp_update_server', 'mcp_remove_server']
  }
]

// ============================================================
// 辅助函数
// ============================================================

/** 格式化单个工具的参数描述 */
function formatParams(def: ToolDefinition): string {
  const params = def.function.parameters as Record<string, unknown>
  const props = params?.properties as Record<string, { type?: string; description?: string }> | undefined
  if (!props) return '(none)'
  return Object.entries(props).map(([k, v]) => `${k}(${v.type || 'any'})`).join(', ')
}

/** 从注册表获取内置工具并按分类生成描述段落 */
function buildBuiltinToolSection(): string {
  const allTools = getAllTools()
  const toolMap = new Map(allTools.map(t => [t.function.name, t]))

  const sections: string[] = ['## Core Tools']
  let hasAnyCategory = false

  for (const cat of TOOL_CATEGORIES) {
    const found = cat.tools
      .map(name => toolMap.get(name))
      .filter((t): t is ToolDefinition => t !== undefined)

    if (found.length === 0) continue
    hasAnyCategory = true

    sections.push(`\n**${cat.label}:**`)
    for (const t of found) {
      const desc = t.function.description || '(no description)'
      const params = formatParams(t)
      sections.push(`- ${t.function.name}: ${desc} (params: ${params})`)
    }
  }

  // 未分类的内置工具（如未来新增的）
  const categorized = new Set(TOOL_CATEGORIES.flatMap(c => c.tools))
  const uncategorized = allTools.filter(t =>
    !categorized.has(t.function.name) && !t.function.name.startsWith('mcp:')
  )
  if (uncategorized.length > 0) {
    hasAnyCategory = true
    sections.push('\n**Other:**')
    for (const t of uncategorized) {
      const desc = t.function.description || '(no description)'
      const params = formatParams(t)
      sections.push(`- ${t.function.name}: ${desc} (params: ${params})`)
    }
  }

  return hasAnyCategory ? sections.join('\n') : ''
}

/** 构建 MCP 工具段落（动态获取连接状态 + 工具列表） */
function buildMcpSection(): string {
  const mcpStatus = getMcpConnectionStatus()
  const connectedServers = mcpStatus.filter(s => s.connected)
  const disconnectedServers = mcpStatus.filter(s => !s.connected)

  // 即使没有 MCP 服务器，也要输出（自管理指南段落有用）
  const lines: string[] = ['\n\n## MCP Tools (External integrations)']

  if (connectedServers.length > 0) {
    const mcpTools = getToolsBySource((s) => s.startsWith('mcp:'))
    if (mcpTools.length > 0) {
      lines.push('The following MCP tools are connected and available. Use them when the task matches their capabilities:')
      for (const t of mcpTools) {
        const desc = t.function.description || '(no description)'
        const params = formatParams(t)
        lines.push(`- **${t.function.name}**: ${desc} (params: ${params})`)
      }
    }
    lines.push('\nWhen a user\'s request could benefit from an MCP tool, prefer using it over built-in tools.')
  } else {
    lines.push('No MCP servers are currently connected.')
  }

  if (disconnectedServers.length > 0) {
    const names = disconnectedServers.map(s => s.name).join(', ')
    lines.push(`\nNote: The following MCP servers are not currently connected (still connecting or failed): ${names}. Their tools are temporarily unavailable.`)
  }

  // 自管理指南：仅当工具确实注册了才输出
  const allBuiltins = getToolsBySource('builtin')
  const hasManager = allBuiltins.some(t => t.function.name === 'mcp_add_server')
  if (hasManager) {
    lines.push(`
### MCP Self-Management
You can manage MCP servers yourself: mcp_list_servers / mcp_add_server / mcp_update_server / mcp_remove_server.
These are DANGEROUS — the user is ALWAYS asked to approve (even in full-auto mode), and the approval dialog shows the complete config.
Rules:
- Only do this when the USER explicitly asks, or when a needed capability is clearly missing and you propose it first.
- BEFORE mcp_add_server, tell the user exactly what will happen: for stdio, the exact command + args that will be executed on their machine; for sse/streamable-http, the URL to be contacted.
- Prefer well-known public MCP servers (e.g. @modelcontextprotocol/server-*, @playwright/mcp, fetch).
- If a connection fails, the server is saved but disabled — fix the config with mcp_update_server or remove it with mcp_remove_server.`)
  }

  return lines.join('\n')
}

// ============================================================
// 主函数：构建完整系统提示词
// ============================================================

export function buildSystemPrompt(
  workspacePath: string,
  skillsPrompt: string,
  memoryPrompt: string,
  extra?: string
): string {
  const builtinSection = buildBuiltinToolSection()
  const mcpSection = buildMcpSection()

  let prompt = `You are Zhumora, an open-source AI agent that can code, automate tasks, and operate your computer. You run in a local Electron desktop environment.

## Environment
- You are connected to a local workspace at: ${workspacePath}
- You also have access to MCP tools and Skills for extended capabilities.${mcpSection}

${builtinSection}

${EDITING_RULES}

${SEARCH_STRATEGY}

${MEMORY_GUIDE}

${GUIDELINES}`

  if (skillsPrompt) {
    prompt += skillsPrompt
  }

  if (memoryPrompt) {
    prompt += memoryPrompt
  }

  if (extra) {
    prompt += `\n\n${extra}`
  }

  return prompt
}
