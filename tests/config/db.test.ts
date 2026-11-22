import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockOn = vi.fn()
const MockPool = vi.fn().mockImplementation(function () { return { on: mockOn } })

vi.mock('pg', () => ({
  default: { Pool: MockPool }
}))

describe('db pool config', () => {
  beforeEach(() => {
    vi.resetModules()
    MockPool.mockClear()
    mockOn.mockClear()
  })

  it('gives the scheduled refresh generous connection and query timeouts', async () => {
    await import('@/config/db.js')
    expect(MockPool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeoutMillis: 10000,
        query_timeout: 30000
      })
    )
  })

  it('attaches an error listener so idle-connection errors do not crash the process', async () => {
    await import('@/config/db.js')
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function))
  })
})
