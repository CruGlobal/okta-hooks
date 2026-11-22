import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handler } from '@/handlers/schedule/sync-restricted-domains.js'
import RestrictedDomains from '@/models/restricted-domains.js'
import pool from '@/config/db.js'
import rollbar from '@/config/rollbar.js'
import type { ScheduledEvent } from 'aws-lambda'

vi.mock('@/config/rollbar.js')

vi.mock('@/config/db.js', () => ({
  default: { query: vi.fn() }
}))

const mockSyncDomainsFromMmd = vi.fn()
vi.mock('@/models/restricted-domains.js', () => ({
  default: vi.fn().mockImplementation(function () {
    return { syncDomainsFromMmd: mockSyncDomainsFromMmd }
  })
}))

describe('sync-restricted-domains handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSyncDomainsFromMmd.mockResolvedValue({ added: 2, removed: 1 })
  })

  it('refreshes restricted domains from MMD and logs the counts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handler({} as ScheduledEvent)
    expect(RestrictedDomains).toHaveBeenCalledWith(pool)
    expect(mockSyncDomainsFromMmd).toHaveBeenCalledWith({ allowLargeDelete: false })
    expect(log).toHaveBeenCalledWith('Restricted domains refreshed from MMD', { added: 2, removed: 1 })
    log.mockRestore()
  })

  it('passes allowLargeDelete when the event sets it to true', async () => {
    await handler({ allowLargeDelete: true } as unknown as ScheduledEvent)
    expect(mockSyncDomainsFromMmd).toHaveBeenCalledWith({ allowLargeDelete: true })
  })

  it.each([
    ['the string "true"', 'true'],
    ['1', 1],
    ['false', false]
  ])('does not pass allowLargeDelete when the event sets it to %s', async (_label, value) => {
    await handler({ allowLargeDelete: value } as unknown as ScheduledEvent)
    expect(mockSyncDomainsFromMmd).toHaveBeenCalledWith({ allowLargeDelete: false })
  })

  it('sends errors to rollbar and rethrows', async () => {
    mockSyncDomainsFromMmd.mockRejectedValue(new Error('Ohh noes!!'))
    await expect(handler({} as ScheduledEvent)).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})
