// ============================================================
// 工具定义公共接口
// ============================================================
import type { ToolDefinition, ToolExecutionResult, ToolHandlerOutput } from '../../shared/types'

/**
 * 工具权限等级（与三档批准模式 AutoApproveMode 配合使用）
 * - safe:      任何模式下都自动放行（只读、无副作用操作）
 * - normal:    manual 模式弹窗确认；auto / full 模式自动放行
 * - dangerous: manual / auto 模式都弹窗确认；仅 full 模式自动放行
 *
 * 批准模式：manual（safe 放行，其余弹窗）/ auto（safe+normal 放行，dangerous 弹窗）/ full（全部放行）
 */
export type PermissionLevel = 'safe' | 'normal' | 'dangerous'

export interface ToolContext {
  workspacePath: string
  sessionId?: string
  /** 当前 Agent 运行的取消信号；长时间工具必须响应它 */
  signal?: AbortSignal
  /** 会话标题更新回调（由 IPC 层注入，转发到渲染进程） */
  onSessionTitleUpdate?: (sessionId: string, title: string) => void
}

export interface ToolHandler {
  definition: ToolDefinition
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolHandlerOutput>
  /** 权限等级，默认 normal */
  permission?: PermissionLevel
  /**
   * 动态权限：根据参数返回权限等级，覆盖静态 permission。
   * 用于"一个工具内含只读和写入"的场景（如 office：read 为 safe，create/edit 为 normal）。
   */
  getPermission?: (args: Record<string, unknown>) => PermissionLevel
  /**
   * 强制弹窗确认：即使 full（全自动批准）模式也弹窗。
   * 用于"配置变更类"工具（如 MCP 服务器增删改）——
   * full 模式的语义是信任 agent 的日常操作，但不包括改变 agent 自身能力边界的操作。
   */
  alwaysConfirm?: boolean
}

/**
 * 统一工具注册表
 * 所有工具（内置 + MCP）都注册到这里供 Agent 调度
 */
export interface RegisteredTool {
  handler: ToolHandler
  source: string
}

export class ToolRegistry {
  private readonly entries = new Map<string, RegisteredTool>()

  register(name: string, handler: ToolHandler, source = 'builtin'): void {
    this.entries.set(name, { handler, source })
  }

  unregisterBySource(source: string): void {
    for (const [name, entry] of this.entries) {
      if (entry.source === source) this.entries.delete(name)
    }
  }

  get(name: string): RegisteredTool | undefined {
    return this.entries.get(name)
  }

  definitions(): ToolDefinition[] {
    return Array.from(this.entries.values()).map(entry => entry.handler.definition)
  }

  definitionsBySource(filter: string | ((source: string) => boolean)): ToolDefinition[] {
    const predicate = typeof filter === 'string' ? (source: string) => source === filter : filter
    return Array.from(this.entries.values())
      .filter(entry => predicate(entry.source))
      .map(entry => entry.handler.definition)
  }

  clear(source?: string): void {
    if (source) this.unregisterBySource(source)
    else this.entries.clear()
  }

  permission(name: string, args?: Record<string, unknown>): PermissionLevel {
    const entry = this.entries.get(name)
    if (!entry) return 'normal'
    if (args && entry.handler.getPermission) return entry.handler.getPermission(args)
    return entry.handler.permission || 'normal'
  }

  alwaysConfirm(name: string): boolean {
    return this.entries.get(name)?.handler.alwaysConfirm === true
  }
}

/** 默认应用实例。仅组合根和适配器使用；业务逻辑优先显式接收 ToolRegistry。 */
export const toolRegistry = new ToolRegistry()

/** 把兼容期输出统一成 runner 使用的标准结构。 */
export function normalizeToolOutput(output: ToolHandlerOutput): ToolExecutionResult {
  return typeof output === 'string' ? { content: output } : output
}

export function registerTool(name: string, handler: ToolHandler, source: string = 'builtin') {
  toolRegistry.register(name, handler, source)
}

export function unregisterToolsBySource(source: string) {
  toolRegistry.unregisterBySource(source)
}

export function getTool(name: string): { handler: ToolHandler; source: string } | undefined {
  return toolRegistry.get(name)
}

export function getAllTools(): ToolDefinition[] {
  return toolRegistry.definitions()
}

/**
 * 按 source 过滤获取工具定义
 * 接受字符串精确匹配或谓词函数
 */
export function getToolsBySource(filter: string | ((source: string) => boolean)): ToolDefinition[] {
  return toolRegistry.definitionsBySource(filter)
}

export function clearTools(source?: string) {
  if (source) {
    unregisterToolsBySource(source)
  } else {
    toolRegistry.clear()
  }
}

/**
 * 获取工具的权限等级。
 * 传入 args 时优先使用 handler.getPermission(args)（动态权限，如 office 的 read/create/edit），
 * 否则回退到静态 permission。
 */
export function getToolPermission(name: string, args?: Record<string, unknown>): PermissionLevel {
  return toolRegistry.permission(name, args)
}

/** 工具是否强制弹窗（full 模式也不放行） */
export function isAlwaysConfirm(name: string): boolean {
  return toolRegistry.alwaysConfirm(name)
}
