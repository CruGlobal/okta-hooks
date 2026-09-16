export const REDACTED = '[REDACTED]'

// Keys whose values are credentials. Matched case-insensitively against the exact
// key name, so `Authorization`, `authorization` and `AUTHORIZATION` all redact.
const SECRET_KEYS = new Set([
  'authorization',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'apikey',
  'api_key',
  'password',
  'secret',
  'client_secret',
  'clientsecret',
  'cookie',
  'set-cookie',
  'x-api-key'
])

// Bounded so a pathological object graph cannot stall a Lambda. The real error
// shapes nest about five deep (error.response.request.headers.Authorization).
const MAX_DEPTH = 8

function walk(value: unknown, depth: number, seen: WeakSet<object>): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return
  if (seen.has(value as object)) return
  seen.add(value as object)

  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1, seen)
    return
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const target = value as Record<string, unknown>
    if (SECRET_KEYS.has(key.toLowerCase())) {
      // Only overwrite if it is actually settable; a getter-only property throws
      // in strict mode and this must never turn an error into a second error.
      try {
        target[key] = REDACTED
      } catch {
        /* non-writable: leave it, the rest of the walk still applies */
      }
      continue
    }
    walk(target[key], depth + 1, seen)
  }
}

/**
 * Strip credentials from an error in place, then return it so callers can
 * rethrow the same object.
 *
 * Why this exists: `request-promise` attaches the full outbound request to the
 * errors it throws, including the `Authorization` header, and attaches the
 * echoed request to `response` as well. When a handler rethrows, the Lambda
 * runtime serialises the whole object into its "Invoke Error" line, which the
 * Datadog extension ships verbatim. A live Global Registry bearer token was
 * found in production logs this way on 2026-09-16.
 *
 * Everything that is not a credential is left untouched, so the error stays as
 * diagnosable as it was before.
 */
export default function redactError<T>(error: T): T {
  try {
    walk(error, 0, new WeakSet())
  } catch {
    /* redaction is best-effort: never let it mask the original failure */
  }
  return error
}
