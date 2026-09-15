import type { ToolContext } from '../tools/registry.ts'
import type { ToolExecutionClass, ToolManifest } from '../tools/manifest.ts'

export interface ToolCapabilityPolicyInput {
  manifest: ToolManifest
  args: Readonly<Record<string, unknown>>
  context: ToolContext
}

export interface ToolCapabilityPolicyDecision {
  allowed: boolean
  reason?: string
}

export interface ToolCapabilityPolicy {
  evaluate(
    input: ToolCapabilityPolicyInput
  ): ToolCapabilityPolicyDecision | Promise<ToolCapabilityPolicyDecision>
}

export interface ManifestCapabilityPolicyOptions {
  allowedCapabilities?: Iterable<string>
  blockedCapabilities?: Iterable<string>
  allowedExecutionClasses?: Iterable<ToolExecutionClass>
  allowLegacyUnclassified?: boolean
}

const CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/

/**
 * Fail-closed policy over immutable manifest metadata. The default keeps legacy
 * tools working while still rejecting malformed and internally inconsistent
 * manifests. Deployments can inject allow/block lists without changing tools.
 */
export class ManifestCapabilityPolicy implements ToolCapabilityPolicy {
  private readonly allowedCapabilities?: ReadonlySet<string>
  private readonly blockedCapabilities: ReadonlySet<string>
  private readonly allowedExecutionClasses?: ReadonlySet<ToolExecutionClass>
  private readonly allowLegacyUnclassified: boolean

  constructor(options: ManifestCapabilityPolicyOptions = {}) {
    this.allowedCapabilities = options.allowedCapabilities
      ? new Set(options.allowedCapabilities)
      : undefined
    this.blockedCapabilities = new Set(options.blockedCapabilities || [])
    this.allowedExecutionClasses = options.allowedExecutionClasses
      ? new Set(options.allowedExecutionClasses)
      : undefined
    this.allowLegacyUnclassified = options.allowLegacyUnclassified !== false
  }

  evaluate({ manifest }: ToolCapabilityPolicyInput): ToolCapabilityPolicyDecision {
    if (this.allowedExecutionClasses && !this.allowedExecutionClasses.has(manifest.executionClass)) {
      return deny(`execution class "${manifest.executionClass}" is not allowed`)
    }
    if (manifest.capabilities.length === 0) return deny('manifest declares no capabilities')

    for (const capability of manifest.capabilities) {
      if (!CAPABILITY_NAME.test(capability)) return deny(`invalid capability name "${capability}"`)
      if (capability === 'legacy.unclassified' && !this.allowLegacyUnclassified) {
        return deny('legacy.unclassified capability is disabled')
      }
      if (this.blockedCapabilities.has(capability)) return deny(`capability "${capability}" is blocked`)
      if (this.allowedCapabilities && !this.allowedCapabilities.has(capability)) {
        return deny(`capability "${capability}" is not allowed`)
      }
    }

    const isMcpSource = manifest.source.startsWith('mcp:')
    const hasMcpCapability = manifest.capabilities.includes('mcp.call')
    if (manifest.executionClass === 'mcp' && (!isMcpSource || !hasMcpCapability)) {
      return deny('MCP execution requires an mcp: source and mcp.call capability')
    }
    if (isMcpSource && manifest.executionClass !== 'mcp') {
      return deny('an mcp: source must use the MCP execution class')
    }
    if (hasMcpCapability && manifest.executionClass !== 'mcp') {
      return deny('mcp.call capability must use the MCP execution class')
    }

    return { allowed: true }
  }
}

function deny(reason: string): ToolCapabilityPolicyDecision {
  return { allowed: false, reason }
}
