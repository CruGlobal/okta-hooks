import { describe, it, expect } from 'vitest'
import redactError, { REDACTED } from '@/utils/redact-error.js'

// Shape taken from a real okta-hooks-prod-create failure observed in Datadog on
// 2026-09-16: request-promise's StatusCodeError carries the outbound request
// options AND the echoed request on the response, each with the Authorization
// header. The handler rethrows, the Lambda runtime serialises the whole object,
// and the live Global Registry bearer token lands in the log in plaintext.
const grStatusCodeError = () => {
  const error = new Error('400 - {"error":"Another entity exists"}') as Error & Record<string, any>
  error.name = 'StatusCodeError'
  error.statusCode = 400
  error.options = {
    baseUrl: 'https://backend.global-registry.org',
    headers: { Accept: 'application/json', Authorization: 'Bearer aee041b40e59b173' },
    uri: '/entities/',
    method: 'POST'
  }
  error.response = {
    statusCode: 400,
    body: { error: 'Another entity exists' },
    request: {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: 'Bearer aee041b40e59b173' }
    }
  }
  return error
}

describe('redactError', () => {
  it('redacts the Authorization header everywhere it appears', () => {
    const error = redactError(grStatusCodeError()) as any
    expect(error.options.headers.Authorization).toBe(REDACTED)
    expect(error.response.request.headers.Authorization).toBe(REDACTED)
    expect(JSON.stringify(error)).not.toContain('aee041b40e59b173')
  })

  it('leaves everything else intact so the error stays diagnosable', () => {
    const error = redactError(grStatusCodeError()) as any
    expect(error.message).toContain('Another entity exists')
    expect(error.name).toBe('StatusCodeError')
    expect(error.statusCode).toBe(400)
    expect(error.options.uri).toBe('/entities/')
    expect(error.options.headers.Accept).toBe('application/json')
    expect(error.response.body).toEqual({ error: 'Another entity exists' })
  })

  it('returns the same object so callers can rethrow it', () => {
    const error = grStatusCodeError()
    expect(redactError(error)).toBe(error)
  })

  it('matches header names case-insensitively', () => {
    const error = new Error('x') as Error & Record<string, any>
    error.a = { authorization: 'Bearer lower' }
    error.b = { AUTHORIZATION: 'Bearer upper' }
    redactError(error)
    expect(error.a.authorization).toBe(REDACTED)
    expect(error.b.AUTHORIZATION).toBe(REDACTED)
  })

  it('redacts other credential-bearing keys', () => {
    const error = new Error('x') as Error & Record<string, any>
    error.cfg = { accessToken: 'tok', access_token: 'tok', password: 'pw', apiKey: 'k' }
    redactError(error)
    expect(error.cfg.accessToken).toBe(REDACTED)
    expect(error.cfg.access_token).toBe(REDACTED)
    expect(error.cfg.password).toBe(REDACTED)
    expect(error.cfg.apiKey).toBe(REDACTED)
  })

  it('survives circular references', () => {
    const error = new Error('x') as Error & Record<string, any>
    error.options = { headers: { Authorization: 'Bearer tok' } }
    error.self = error
    error.options.back = error.options
    expect(() => redactError(error)).not.toThrow()
    expect(error.options.headers.Authorization).toBe(REDACTED)
  })

  it('walks arrays', () => {
    const error = new Error('x') as Error & Record<string, any>
    error.attempts = [{ headers: { Authorization: 'Bearer one' } }]
    redactError(error)
    expect(error.attempts[0].headers.Authorization).toBe(REDACTED)
  })

  it('tolerates non-object input', () => {
    expect(() => redactError(undefined)).not.toThrow()
    expect(() => redactError('boom')).not.toThrow()
    expect(redactError(null)).toBe(null)
  })
})
