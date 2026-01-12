import { describe, it, expect } from 'vitest'
import { handler } from '@/handlers/alb/verification.js'

describe('verification event hook', () => {
  it('should respond with verification challenge', async () => {
    const response = await handler({ headers: { 'x-okta-verification-challenge': 'abc123' } } as any)
    expect(response).toStrictEqual({
      statusCode: 200,
      statusDescription: '200 OK',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({ verification: 'abc123' })
    })
  })
})
