// ============================================================
// 系统提示词构建 — 从工具注册表动态生成工具描述
// 参考 Cline / opencode 的提示词设计，针对 Zhumora 的 Electron 桌面环境定制
// ============================================================
import type { ToolDefinition } from '../../shared/types'

export interface PromptRuntimeSnapshot {
  tools: ToolDefinition[]
  builtinTools: ToolDefinition[]
  mcpTools: ToolDefinition[]
  mcpServers: Array<{ id: string; name: string; connected: boolean }>
}

// ============================================================
// 静态指导文本（与具体工具列表无关的通用规则）
// ============================================================

const TONE_AND_STYLE = `## Tone and Style
- Be concise, direct, and to the point. Minimize output tokens while maintaining helpfulness and accuracy.
- When you run a non-trivial bash command, briefly explain what it does and why you are running it.
- Your output is rendered as GitHub-flavored Markdown in a desktop application.
- Avoid unnecessary preamble ("Here's what I'll do...") and postamble ("I hope this helps!") unless the user asks.
- Only use emojis if the user explicitly requests them.
- If you cannot or will not help with something, keep your response to 1-2 sentences and offer an alternative if possible.`

const AUTONOMY = `## Autonomy and Persistence
- Unless the user is asking a question, brainstorming, or explicitly requesting a plan, assume they want you to make changes. Go ahead and implement — don't just describe what you would do.
- Persist until the task is fully handled end-to-end: implement, then verify (run tests, check build, read the edited file back). Do not stop at analysis or partial fixes.
- If you encounter blockers, attempt to resolve them yourself before asking for help.
- If you notice unexpected changes in the workspace that you did not make, continue with your task. NEVER revert, undo, or modify changes you did not make unless the user explicitly asks.`

const CONVENTIONS = `## Following Conventions
- Before editing a file, read its surrounding context (especially imports) to understand the code's style, framework, and patterns. Mimic them.
- NEVER assume a library is available. Check package.json (or equivalent) before writing code that imports it.
- When creating new code, look at existing files to match naming, structure, and conventions.
- Always follow security best practices. Never expose or log secrets and keys.`

const EDITING_APPROACH = `## Editing Approach
- The best change is often the smallest correct change. Prefer the minimal approach when two correct options exist.
- ALWAYS prefer editing existing files. NEVER create new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files unless the user asks.
- Do not add code comments unless the logic is genuinely non-obvious.
- ALWAYS read a file before editing it. Never use edit with a guessed oldString — if it doesn't match, the edit will fail.
- For large changes across many non-Office text/code files, prefer bash with sed/awk or write the entire file.
- Always verify your edits at the end: read the edited file back or run the project's build/lint/tests.`

const TOOL_USAGE_POLICY = `## Tool Usage Policy
- You can call multiple tools in a single response. When several independent reads, searches, commands, or edits are needed, emit them all together — do not serialize independent work across turns.
- Good parallelism: read all known relevant files at once; run independent inspection commands together; edit multiple files in one response.
- For file operations, prefer the dedicated tools over bash: use read (not cat/type), glob (not dir /s / find), grep (not findstr / grep in bash), edit (not sed), write (not echo > file).
- For Office artifacts, use the matching word_document, excel_workbook, powerpoint_presentation, or pdf_document tool first. Use shell/code tools only when the user explicitly asks for source code or the Office tool reports that the requested capability is unsupported.
- When referencing code, use the format \`file_path:line_number\` so the user can navigate to the source.`

const TASK_GUIDELINES = `## Guidelines
- If a task requires multiple steps, state your plan briefly, then execute step by step.
- Always explain what you are doing and why before running potentially impactful operations.
- If you are unsure about something, ask the user for clarification instead of guessing.
- When the task is complete, provide a brief summary of what you did.
- NEVER commit, push, or create PRs unless the user explicitly asks.
- NEVER use destructive commands like \`git reset --hard\` or \`git checkout --\` unless the user explicitly requests them.`

const MEMORY_GUIDE = `## Long-term Memory
You have access to a persistent memory system. You can proactively use these tools:
- memory_search: Search stored memories about the user's preferences, habits, facts, skills, and project context.
- memory_save: Save a new memory when you detect something worth remembering about the user.
- memory_list: List all stored memories or filter by category.
- memory_delete: Delete an outdated or incorrect memory (confirm with user first).

When to use memory tools:
- Use memory_search near the start only when prior preferences or project context are likely to matter.
- When the user mentions a preference, habit, or important context, call memory_save to store it.
- When the user asks "do you remember..." or refers to past conversations, use memory_search to find relevant memories.
- Do NOT save trivial information (e.g. "user said hello"). Only save durable, useful facts.`

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
    tools: ['desktop_observe', 'desktop_action']
  },
  {
    label: 'Office Documents',
    tools: ['word_document', 'excel_workbook', 'powerpoint_presentation', 'pdf_document']
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

/**
 * 系统提示词概览只用描述首行做摘要。
 * 完整的多行使用指导（何时用/何时不用/失败模式/示例）由 tool schema 承载，
 * 模型每次请求都能从 schema 中读到；概览段只负责"有哪些工具、各管什么"，
 * 避免系统提示词膨胀（对齐 Cline / opencode：系统提示词不含冗长工具列表）。
 */
function summarizeDescription(def: ToolDefinition): string {
  const desc = (def.function.description || '').trim()
  const firstLine = desc.split('\n')[0] || '(no description)'
  return firstLine.length > 200 ? firstLine.slice(0, 197) + '...' : firstLine
}

/** 从注册表获取内置工具并按分类生成描述段落 */
function buildBuiltinToolSection(allTools: ToolDefinition[]): string {
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
      const desc = summarizeDescription(t)
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
      const desc = summarizeDescription(t)
      const params = formatParams(t)
      sections.push(`- ${t.function.name}: ${desc} (params: ${params})`)
    }
  }

  return hasAnyCategory ? sections.join('\n') : ''
}

/** 构建 MCP 工具段落（动态获取连接状态 + 工具列表） */
function buildMcpSection(snapshot: PromptRuntimeSnapshot): string {
  const mcpStatus = snapshot.mcpServers
  const connectedServers = mcpStatus.filter(s => s.connected)
  const disconnectedServers = mcpStatus.filter(s => !s.connected)

  // 即使没有 MCP 服务器，也要输出（自管理指南段落有用）
  const lines: string[] = ['\n\n## MCP Tools (External integrations)']

  if (connectedServers.length > 0) {
    const mcpTools = snapshot.mcpTools
    if (mcpTools.length > 0) {
      lines.push('The following MCP tools are connected and available. Use them when the task matches their capabilities:')
      for (const t of mcpTools) {
        const desc = summarizeDescription(t)
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
  const hasManager = snapshot.builtinTools.some(t => t.function.name === 'mcp_add_server')
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
  runtime: PromptRuntimeSnapshot,
  extra?: string,
  topExtra?: string
): string {
  const builtinSection = buildBuiltinToolSection(runtime.tools)
  const mcpSection = buildMcpSection(runtime)
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  let prompt = `You are Zhumora, an open-source AI agent that can code, automate tasks, and operate your computer. You run in a local Electron desktop environment.

## Environment
- Platform: ${platform}
- Working directory: ${workspacePath}
- Date: ${date}
- You also have access to MCP tools and Skills for extended capabilities.${mcpSection}
${topExtra ? '\n' + topExtra + '\n' : ''}
${TONE_AND_STYLE}

${AUTONOMY}

${CONVENTIONS}

${EDITING_APPROACH}

${TOOL_USAGE_POLICY}

${builtinSection}

${MEMORY_GUIDE}

${TASK_GUIDELINES}`

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
