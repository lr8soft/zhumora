import { createHash } from 'node:crypto'
import type { ToolDefinition } from '../../shared/types'

export type ToolExecutionClass =
  | 'in-process'
  | 'host-process'
  | 'sandbox'
  | 'mcp'
  | 'browser'
  | 'desktop'

export type ToolConcurrency = 'parallel' | 'session-exclusive' | 'global-exclusive'
export type ToolIdempotency = 'idempotent' | 'keyed' | 'non-idempotent' | 'unknown'

/**
 * Stable metadata owned by the harness rather than by a transport adapter.
 * Capability, concurrency, idempotency, and execution-class fields are policy
 * inputs; ToolExecutionService owns the enforcement path as policies migrate.
 */
export interface ToolManifest {
  /** Stable harness identity. It is never sent to the model as a function name. */
  id: string
  /** Model-visible function name. */
  name: string
  /** Upstream name before transport namespacing, for example the MCP tool name. */
  originalName: string
  source: string
  version: string
  inputSchema: object
  outputSchema?: object
  capabilities: readonly string[]
  executionClass: ToolExecutionClass
  concurrency: ToolConcurrency
  idempotency: ToolIdempotency
}

export interface ToolManifestOverrides {
  originalName?: string
  version?: string
  outputSchema?: object
  capabilities?: readonly string[]
  executionClass?: ToolExecutionClass
  concurrency?: ToolConcurrency
  idempotency?: ToolIdempotency
}

export function createToolManifest(
  name: string,
  definition: ToolDefinition,
  source: string,
  overrides: ToolManifestOverrides = {}
): ToolManifest {
  const originalName = overrides.originalName || name
  const inputSchema = cloneFrozenSchema(definition.function.parameters)
  const outputSchema = overrides.outputSchema ? cloneFrozenSchema(overrides.outputSchema) : undefined
  return Object.freeze({
    id: `${source}/${originalName}`,
    name,
    originalName,
    source,
    version: overrides.version || '1',
    inputSchema,
    outputSchema,
    capabilities: Object.freeze([...(overrides.capabilities || defaultCapabilities(source))]),
    executionClass: overrides.executionClass || inferExecutionClass(name, source),
    concurrency: overrides.concurrency || 'parallel',
    idempotency: overrides.idempotency || 'unknown'
  })
}

function cloneFrozenSchema<T extends object>(schema: T): T {
  return deepFreeze(structuredClone(schema))
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

/**
 * MCP tool names live in one provider-wide function namespace. Always include
 * the server id and a stable digest so different servers and lossy sanitization
 * can never silently shadow one another.
 */
export function createMcpToolName(serverId: string, originalName: string): string {
  const server = sanitizeFunctionName(serverId) || 'server'
  const tool = sanitizeFunctionName(originalName) || 'tool'
  const digest = createHash('sha256')
    .update(`${serverId}\0${originalName}`)
    .digest('hex')
    .slice(0, 8)
  const suffix = `__${digest}`
  const prefixBudget = 64 - suffix.length
  return `mcp__${server}__${tool}`.slice(0, prefixBudget) + suffix
}

export function isValidModelToolName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name)
}

function sanitizeFunctionName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function defaultCapabilities(source: string): readonly string[] {
  return source.startsWith('mcp:') ? ['mcp.call'] : ['legacy.unclassified']
}

function inferExecutionClass(name: string, source: string): ToolExecutionClass {
  if (source.startsWith('mcp:')) return 'mcp'
  if (name === 'bash') return 'host-process'
  if (name.startsWith('browser_')) return 'browser'
  if (name.startsWith('desktop_')) return 'desktop'
  return 'in-process'
}
