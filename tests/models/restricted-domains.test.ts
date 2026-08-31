import { describe, it, expect, vi, beforeEach } from 'vitest'
import RestrictedDomains from '@/models/restricted-domains.js'
import pool from '@/config/db.js'
import flags from '@/config/flags.js'
import {
  auth,
  sheets,
  mockSpreadsheetsGet
} from '../mocks/googleapis-sheets.js'
import {
  mockDynamoDBSend,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  BatchWriteCommand
} from '../mocks/aws-sdk-v3.js'

vi.mock('@/config/db.js', () => ({
  default: { query: vi.fn() }
}))

vi.mock('@/config/flags.js', () => ({
  default: { enabled: vi.fn(), refresh: vi.fn() }
}))

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const mock = await import('../mocks/aws-sdk-v3.js')
  return { DynamoDBClient: mock.DynamoDBClient }
})

vi.mock('@aws-sdk/lib-dynamodb', async () => {
  const mock = await import('../mocks/aws-sdk-v3.js')
  return {
    DynamoDBDocumentClient: mock.DynamoDBDocumentClient,
    GetCommand: mock.GetCommand,
    ScanCommand: mock.ScanCommand,
    BatchWriteCommand: mock.BatchWriteCommand
  }
})

vi.mock('@googleapis/sheets', async () => {
  const sheetsMock = await import('../mocks/googleapis-sheets.js')
  return { auth: sheetsMock.auth, sheets: sheetsMock.sheets }
})

const mockQuery = vi.mocked(pool.query)
const mockFlagEnabled = vi.mocked(flags.enabled)
const mockFlagRefresh = vi.mocked(flags.refresh)

describe('RestrictedDomains', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFlagEnabled.mockReturnValue(false)
  })

  describe('static isRestricted(emailAddress)', () => {
    describe('with the restricted_domains_postgres flag enabled', () => {
      beforeEach(() => {
        mockFlagEnabled.mockReturnValue(true)
      })

      it('is true when the domain is flagged in MMD Postgres', async () => {
        mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ '?column?': 1 }] } as never)
        const result = await RestrictedDomains.isRestricted('tony.stark@Avengers.org')
        expect(result).toBe(true)
        expect(mockQuery).toHaveBeenCalledWith(
          'SELECT 1 FROM "Domains" WHERE lower(domain) = $1 AND is_idm_self_service_prevention = true LIMIT 1',
          ['avengers.org']
        )
        expect(mockDynamoDBSend).not.toHaveBeenCalled()
        expect(mockFlagRefresh).toHaveBeenCalled()
        expect(mockFlagEnabled).toHaveBeenCalledWith('restricted_domains_postgres')
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

    describe('with the restricted_domains_postgres flag disabled (default)', () => {
      it('is true when the domain is in the DynamoDB table', async () => {
        mockDynamoDBSend.mockResolvedValue({ Item: { DomainName: 'avengers.org' } })
        const result = await RestrictedDomains.isRestricted('tony.stark@Avengers.org')
        expect(result).toBe(true)
        expect(DynamoDBDocumentClient.from).toHaveBeenCalled()
        expect(GetCommand).toHaveBeenCalledWith({
          TableName: 'restricted_domains_dynamodb',
          Key: { DomainName: 'avengers.org' }
        })
        expect(mockQuery).not.toHaveBeenCalled()
      })

      it('is false when the domain is not in the DynamoDB table', async () => {
        mockDynamoDBSend.mockResolvedValue({})
        const result = await RestrictedDomains.isRestricted('tony.stark@avengers.org')
        expect(result).toBe(false)
      })

      it('is false for an invalid email address without querying or refreshing flags', async () => {
        const result = await RestrictedDomains.isRestricted('not-a-valid-email')
        expect(result).toBe(false)
        expect(mockDynamoDBSend).not.toHaveBeenCalled()
        expect(mockFlagRefresh).not.toHaveBeenCalled()
      })

      it('refreshes the flag snapshot before deciding', async () => {
        mockDynamoDBSend.mockResolvedValue({})
        await RestrictedDomains.isRestricted('tony.stark@avengers.org')
        expect(mockFlagRefresh).toHaveBeenCalled()
      })
    })
  })

  describe('allDomains()', () => {
    it('returns an array of all domains from DynamoDB', async () => {
      mockDynamoDBSend.mockResolvedValue({ Items: [{ DomainName: 'cru.org' }, { DomainName: 'avengers.org' }] })
      const result = await new RestrictedDomains().allDomains()
      expect(result).toEqual(['cru.org', 'avengers.org'])
      expect(ScanCommand).toHaveBeenCalledWith({ TableName: 'restricted_domains_dynamodb' })
    })

    it('returns empty array when Items is undefined', async () => {
      mockDynamoDBSend.mockResolvedValue({})
      const result = await new RestrictedDomains().allDomains()
      expect(result).toEqual([])
    })
  })

  describe('googleSheetDomains()', () => {
    it('returns an array of all the domains in the google sheet', async () => {
      mockSpreadsheetsGet.mockResolvedValue({ data: { values: [['cru.org'], ['Avengers.org'], ['example.com']] } })
      const result = await new RestrictedDomains().googleSheetDomains()
      expect(result).toEqual(['cru.org', 'avengers.org', 'example.com'])
      expect(auth.JWT).toHaveBeenCalledWith({
        email: 'client@okta-hooks.example.com',
        key: '-----BEGIN PRIVATE KEY-----\nabcdefg012345\n-----END PRIVATE KEY-----\n',
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
      })
      expect(sheets).toHaveBeenCalledWith({ version: 'v4', auth: (auth.JWT as any).mock.instances[0] })
      expect(mockSpreadsheetsGet).toHaveBeenCalledWith({
        spreadsheetId: 'google_spreadsheet',
        range: "'Okta self-service prevention'!A2:A"
      })
    })

    it('throws an error if the list is empty', async () => {
      mockSpreadsheetsGet.mockResolvedValue({ data: {} })
      await expect(new RestrictedDomains().googleSheetDomains())
        .rejects.toThrow('Restricted Domains Google sheet returned empty response.')
    })
  })

  describe('syncDomainsFromGoogle()', () => {
    it('updates DynamoDB with changes from Google', async () => {
      mockSpreadsheetsGet.mockResolvedValue({
        data: {
          values: [
            ['cru.org'],
            ['Avengers.org'],
            ['example.com'],
            ['Cru.org'],
            ['']]
        }
      })
      mockDynamoDBSend.mockResolvedValue({
        Items: [
          { DomainName: 'cru.org' },
          { DomainName: 'avengers.org' },
          { DomainName: 'ccci.org' }
        ]
      })
      await new RestrictedDomains().syncDomainsFromGoogle()
      expect(BatchWriteCommand).toHaveBeenCalledWith({
        RequestItems: {
          restricted_domains_dynamodb: [
            { PutRequest: { Item: { DomainName: 'example.com' } } },
            { DeleteRequest: { Key: { DomainName: 'ccci.org' } } }
          ]
        }
      })
    })

    it('does nothing if there are no changes', async () => {
      mockSpreadsheetsGet.mockResolvedValue({ data: { values: [['cru.org']] } })
      mockDynamoDBSend.mockResolvedValue({ Items: [{ DomainName: 'cru.org' }] })
      await new RestrictedDomains().syncDomainsFromGoogle()
      expect(BatchWriteCommand).not.toHaveBeenCalled()
    })
  })
})
