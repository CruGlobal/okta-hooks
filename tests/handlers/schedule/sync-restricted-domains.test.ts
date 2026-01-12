import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handler } from '@/handlers/schedule/sync-restricted-domains.js'
import RestrictedDomains from '@/models/restricted-domains.js'
import rollbar from '@/config/rollbar.js'

vi.mock('@/config/rollbar.js')

const mockSyncDomainsFromGoogle = vi.fn()
vi.mock('@/models/restricted-domains.js', () => ({
  default: vi.fn().mockImplementation(() => ({
    syncDomainsFromGoogle: mockSyncDomainsFromGoogle
  }))
}))

describe('sync-restricted-domains handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should sync restricted domains from google', async () => {
    await handler({})
    expect(RestrictedDomains).toHaveBeenCalled()
    expect(mockSyncDomainsFromGoogle).toHaveBeenCalled()
  })

  it('should send error to rollbar', async () => {
    mockSyncDomainsFromGoogle.mockRejectedValue(new Error('Ohh noes!!'))
    await expect(handler({})).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})
