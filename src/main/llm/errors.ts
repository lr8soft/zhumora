/**
 * llama.cpp returns HTTP 500 for malformed client-supplied historical tool
 * arguments. This is a deterministic request error, not a transient server
 * failure, so retrying the identical payload can never recover.
 */
export function isMalformedToolArgumentsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message || ''
  return /failed to parse tool call arguments as json|func_args_not_string|invalid tool call arguments/i.test(message)
}
