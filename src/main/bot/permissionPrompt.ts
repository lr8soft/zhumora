import type { PermissionRequest } from '../agent/permissionBroker'

const SENSITIVE_KEY = /(authorization|api[-_]?key|password|secret|token)/i

export function formatBotPermissionPrompt(request: PermissionRequest, maxCharacters = 2800): string {
  const args = JSON.stringify(redactSensitive(request.args), null, 2)
  const clipped = Array.from(args).slice(0, maxCharacters).join('')
  return [
    `Permission required (${request.level})`,
    `Tool: ${request.toolName}`,
    '',
    clipped
  ].join('\n')
}

function redactSensitive(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map(item => redactSensitive(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entryValue]) => [entryKey, redactSensitive(entryValue, entryKey)]))
  }
  return value
}
