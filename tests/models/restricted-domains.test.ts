import { describe, it, expect, vi, beforeEach } from 'vitest'
import RestrictedDomains from '@/models/restricted-domains.js'
import pool from '@/config/db.js'

vi.mock('@/config/db.js', () => ({
  default: { query: vi.fn() }
}))

const mockQuery = vi.mocked(pool.query)

describe('RestrictedDomains', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('static isRestricted(emailAddress)', () => {
    it('is true when the domain is flagged in MMD Postgres', async () => {
      mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ '?column?': 1 }] } as never)
      const result = await RestrictedDomains.isRestricted('tony.stark@Avengers.org')
      expect(result).toBe(true)
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT 1 FROM "Domains" WHERE lower(domain) = $1 AND is_idm_self_service_prevention = true LIMIT 1',
        ['avengers.org']
      )
    })

    it('is false when the domain is not flagged', async () => {
      mockQuery.mockResolvedValue({ rowCount: 0, rows: [] } as never)
      const result = await RestrictedDomains.isRestricted('tony.stark@avengers.org')
      expect(result).toBe(false)
    })

    it('is false for an invalid email address without querying', async () => {
      const result = await RestrictedDomains.isRestricted('not-a-valid-email')
      expect(result).toBe(false)
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('propagates query errors (registration handler fails open)', async () => {
      mockQuery.mockRejectedValue(new Error('connection refused'))
      await expect(RestrictedDomains.isRestricted('tony.stark@avengers.org'))
        .rejects.toThrow('connection refused')
    })
  })
})
