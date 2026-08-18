import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockOn = vi.fn()
const MockPool = vi.fn().mockImplementation(() => ({ on: mockOn }))

vi.mock('pg', () => ({
  default: { Pool: MockPool }
}))

describe('db pool config', () => {
  beforeEach(() => {
    vi.resetModules()
    MockPool.mockClear()
    mockOn.mockClear()
  })

  it('configures connection and query timeouts', async () => {
    await import('@/config/db.js')
    expect(MockPool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeoutMillis: 2000,
        query_timeout: 2000
      })
    )
  })

  it('attaches an error listener so idle-connection errors do not crash the process', async () => {
    await import('@/config/db.js')
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function))
  })
})
