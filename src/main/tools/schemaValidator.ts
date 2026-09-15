export interface SchemaValidationIssue {
  path: string
  keyword: string
  message: string
}

export interface SchemaValidationResult {
  valid: boolean
  issues: SchemaValidationIssue[]
}

type JsonSchema = boolean | Record<string, unknown>

const MAX_SCHEMA_DEPTH = 64

/**
 * Pure JSON Schema subset used by tool definitions. It deliberately has no
 * side effects. ToolExecutionService runs it before permission presentation.
 * Unsupported keywords remain annotations; supported constraints fail closed.
 */
export function validateToolArguments(schema: object, value: unknown): SchemaValidationResult {
  const issues: SchemaValidationIssue[] = []
  validateNode(schema as JsonSchema, value, '$', issues, 0)
  return { valid: issues.length === 0, issues }
}

function validateNode(schema: JsonSchema, value: unknown, path: string, issues: SchemaValidationIssue[], depth: number): void {
  if (schema === true) return
  if (schema === false) {
    issue(issues, path, 'falseSchema', 'value is not allowed')
    return
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    issue(issues, path, 'maxDepth', `schema nesting exceeds ${MAX_SCHEMA_DEPTH}`)
    return
  }

  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) validateNode(asSchema(child), value, path, issues, depth + 1)
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(child => isValid(asSchema(child), value, depth + 1))) {
    issue(issues, path, 'anyOf', 'value does not match any allowed schema')
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(child => isValid(asSchema(child), value, depth + 1)).length
    if (matches !== 1) issue(issues, path, 'oneOf', `value must match exactly one schema, matched ${matches}`)
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => deepEqual(candidate, value))) {
    issue(issues, path, 'enum', 'value is not in the allowed set')
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    issue(issues, path, 'const', 'value does not match the required constant')
  }

  const types = normalizeTypes(schema.type)
  if (types.length > 0 && !types.some(type => matchesType(type, value))) {
    issue(issues, path, 'type', `expected ${types.join(' or ')}, received ${describeType(value)}`)
    return
  }

  if (typeof value === 'string') validateString(schema, value, path, issues)
  if (typeof value === 'number') validateNumber(schema, value, path, issues)
  if (Array.isArray(value)) validateArray(schema, value, path, issues, depth)
  if (isRecord(value)) validateObject(schema, value, path, issues, depth)
}

function validateString(schema: Record<string, unknown>, value: string, path: string, issues: SchemaValidationIssue[]): void {
  if (isNumber(schema.minLength) && value.length < schema.minLength) issue(issues, path, 'minLength', `length must be at least ${schema.minLength}`)
  if (isNumber(schema.maxLength) && value.length > schema.maxLength) issue(issues, path, 'maxLength', `length must be at most ${schema.maxLength}`)
  if (typeof schema.pattern === 'string') {
    try {
      if (!new RegExp(schema.pattern, 'u').test(value)) issue(issues, path, 'pattern', 'value does not match the required pattern')
    } catch {
      issue(issues, path, 'pattern', 'schema contains an invalid regular expression')
    }
  }
}

function validateNumber(schema: Record<string, unknown>, value: number, path: string, issues: SchemaValidationIssue[]): void {
  if (!Number.isFinite(value)) issue(issues, path, 'type', 'number must be finite')
  if (isNumber(schema.minimum) && value < schema.minimum) issue(issues, path, 'minimum', `value must be at least ${schema.minimum}`)
  if (isNumber(schema.maximum) && value > schema.maximum) issue(issues, path, 'maximum', `value must be at most ${schema.maximum}`)
  if (isNumber(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) issue(issues, path, 'exclusiveMinimum', `value must be greater than ${schema.exclusiveMinimum}`)
  if (isNumber(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) issue(issues, path, 'exclusiveMaximum', `value must be less than ${schema.exclusiveMaximum}`)
}

function validateArray(schema: Record<string, unknown>, value: unknown[], path: string, issues: SchemaValidationIssue[], depth: number): void {
  if (isNumber(schema.minItems) && value.length < schema.minItems) issue(issues, path, 'minItems', `array must contain at least ${schema.minItems} item(s)`)
  if (isNumber(schema.maxItems) && value.length > schema.maxItems) issue(issues, path, 'maxItems', `array must contain at most ${schema.maxItems} item(s)`)
  if (schema.uniqueItems === true && new Set(value.map(stableValue)).size !== value.length) issue(issues, path, 'uniqueItems', 'array items must be unique')
  if (schema.items !== undefined) {
    const itemSchema = asSchema(schema.items)
    value.forEach((item, index) => validateNode(itemSchema, item, `${path}[${index}]`, issues, depth + 1))
  }
}

function validateObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  issues: SchemaValidationIssue[],
  depth: number
): void {
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) issue(issues, childPath(path, key), 'required', 'required property is missing')
  }

  const properties = isRecord(schema.properties) ? schema.properties : {}
  for (const [key, child] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      validateNode(asSchema(child), value[key], childPath(path, key), issues, depth + 1)
    }
  }

  const extras = Object.keys(value).filter(key => !Object.prototype.hasOwnProperty.call(properties, key))
  if (schema.additionalProperties === false) {
    for (const key of extras) issue(issues, childPath(path, key), 'additionalProperties', 'additional property is not allowed')
  } else if (isRecord(schema.additionalProperties) || typeof schema.additionalProperties === 'boolean') {
    const additionalSchema = asSchema(schema.additionalProperties)
    for (const key of extras) validateNode(additionalSchema, value[key], childPath(path, key), issues, depth + 1)
  }
}

function normalizeTypes(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function matchesType(type: string, value: unknown): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isRecord(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer'
  return typeof value
}

function isValid(schema: JsonSchema, value: unknown, depth: number): boolean {
  const issues: SchemaValidationIssue[] = []
  validateNode(schema, value, '$', issues, depth)
  return issues.length === 0
}

function asSchema(value: unknown): JsonSchema {
  return typeof value === 'boolean' || isRecord(value) ? value : false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

function issue(issues: SchemaValidationIssue[], path: string, keyword: string, message: string): void {
  issues.push({ path, keyword, message })
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableValue(left) === stableValue(right)
}
