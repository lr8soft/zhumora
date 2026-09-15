// ============================================================
// Memory Tools — LLM 可主动调用的记忆工具集
// 让 Agent 能搜索、保存、列出、删除长期记忆
// ============================================================
import type { ToolHandler, ToolContext, ToolRegistration } from './registry'
import { getMemories, addMemory, deleteMemory, touchMemory } from '../store/db'
import type { MemoryCategory } from '../../shared/types'
import { log } from '../llm/logger'

// ---- 搜索记忆 ----
export const memorySearchTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_search',
      description: 'Search the user\'s long-term memory for preferences, habits, facts, skills, or project context. Use this proactively when you need to understand the user\'s background, working style, or past preferences to give a better response. Keywords are matched against memory content and tags.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords (space-separated). Matches against memory content and tags.' },
          category: { type: 'string', description: 'Optional filter: preference | habit | fact | skill | context', enum: ['preference', 'habit', 'fact', 'skill', 'context'] },
          limit: { type: 'number', description: 'Max results to return (default 10, max 50)' }
        },
        required: ['query']
      }
    }
  },
  permission: 'safe',
  async execute(args) {
    const query = args.query as string
    const category = args.category as MemoryCategory | undefined
    const limit = Math.min((args.limit as number) || 10, 50)

    if (!query || !query.trim()) {
      return 'Error: query is required'
    }

    const memories = getMemories({ search: query, category, limit })
    for (const mem of memories) {
      touchMemory(mem.id)
    }

    if (memories.length === 0) {
      return `No memories found matching "${query}".`
    }

    const lines = memories.map(m =>
      `[${m.category}] (importance:${m.importance}/5) ${m.content}${m.tags.length > 0 ? ` [tags: ${m.tags.join(', ')}]` : ''}`
    )
    return `Found ${memories.length} memories:\n${lines.join('\n')}`
  }
}

// ---- 保存记忆 ----
export const memorySaveTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_save',
      description: 'Save a new memory about the user. Use this when the user explicitly tells you to remember something, or when you detect an important preference, habit, fact, skill, or project context that would be useful in future conversations. Do NOT save trivial or generic information.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The memory content — a concise, self-contained statement (e.g. "User prefers Vue 3 over React for frontend projects")' },
          category: { type: 'string', description: 'Memory category', enum: ['preference', 'habit', 'fact', 'skill', 'context'] },
          importance: { type: 'number', description: 'Importance level 1-5 (5 = critical, 3 = moderate, 1 = trivial). Default 3.', minimum: 1, maximum: 5 },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional keywords for future retrieval (e.g. ["vue", "frontend", "framework"])' }
        },
        required: ['content', 'category']
      }
    }
  },
  permission: 'safe',
  async execute(args, ctx) {
    const content = (args.content as string || '').trim()
    const category = args.category as MemoryCategory
    const importance = Math.max(1, Math.min(5, (args.importance as number) || 3))
    const tags = (args.tags as string[]) || []

    if (!content) return 'Error: content is required'
    if (!category) return 'Error: category is required'

    // 去重检查
    const existing = getMemories({ search: content.slice(0, 30), limit: 5 })
    const isDuplicate = existing.some(e =>
      e.content.toLowerCase() === content.toLowerCase()
    )
    if (isDuplicate) {
      return `Memory already exists (duplicate skipped): "${content}"`
    }

    const entry = addMemory({
      category,
      content,
      importance,
      sourceSessionId: ctx.sessionId || null,
      tags
    })

    log('info', `[Memory] LLM saved memory: [${category}] "${content.slice(0, 60)}"`)
    return `Memory saved successfully (id: ${entry.id}, category: ${category}, importance: ${importance}/5).`
  }
}

// ---- 列出记忆 ----
export const memoryListTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_list',
      description: 'List all stored memories, optionally filtered by category. Use this when you need an overview of everything remembered about the user.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional filter: preference | habit | fact | skill | context', enum: ['preference', 'habit', 'fact', 'skill', 'context'] },
          limit: { type: 'number', description: 'Max results (default 20, max 100)' }
        }
      }
    }
  },
  permission: 'safe',
  async execute(args) {
    const category = args.category as MemoryCategory | undefined
    const limit = Math.min((args.limit as number) || 20, 100)

    const memories = getMemories({ category, limit })
    for (const mem of memories) {
      touchMemory(mem.id)
    }

    if (memories.length === 0) {
      return category ? `No memories in category "${category}".` : 'No memories stored yet.'
    }

    const lines = memories.map((m, i) =>
      `${i + 1}. [${m.category}] (★${m.importance}) ${m.content}${m.tags.length > 0 ? ` [#${m.tags.join(' #')}]` : ''}`
    )
    return `Memory entries (${memories.length}):\n${lines.join('\n')}`
  }
}

// ---- 删除记忆 ----
export const memoryDeleteTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: 'Delete a specific memory by its ID. Only use when the user explicitly asks to forget/remove something, or when a memory is outdated/wrong. ALWAYS confirm with the user before deleting unless they explicitly requested it.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The memory entry ID to delete. Use memory_list or memory_search first to find the ID.' }
        },
        required: ['id']
      }
    }
  },
  permission: 'normal',
  async execute(args) {
    const id = args.id as string
    if (!id) return 'Error: id is required'

    deleteMemory(id)
    log('info', `[Memory] LLM deleted memory: ${id}`)
    return `Memory ${id} deleted.`
  }
}

// 导出所有记忆工具
export const memoryTools: ToolRegistration[] = [
  { name: 'memory_search', handler: memorySearchTool, manifest: { capabilities: ['memory.read'], idempotency: 'non-idempotent' } },
  { name: 'memory_save', handler: memorySaveTool, manifest: { capabilities: ['memory.write'], idempotency: 'non-idempotent' } },
  { name: 'memory_list', handler: memoryListTool, manifest: { capabilities: ['memory.read'], idempotency: 'non-idempotent' } },
  { name: 'memory_delete', handler: memoryDeleteTool, manifest: { capabilities: ['memory.write'], idempotency: 'non-idempotent' } }
]
