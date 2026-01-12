import { describe, it, expect, vi, beforeEach } from 'vitest'
import RestrictedDomains from '@/models/restricted-domains.js'
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

describe('RestrictedDomains', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('static isRestricted(domain)', () => {
    it('should be true when domain name is restricted', async () => {
      mockDynamoDBSend.mockResolvedValue({ Item: { DomainName: 'avengers.org' } })
      const result = await RestrictedDomains.isRestricted('tony.stark@avengers.org')
      expect(result).toBeTruthy()
      expect(DynamoDBDocumentClient.from).toHaveBeenCalled()
      expect(GetCommand).toHaveBeenCalledWith({
        TableName: 'restricted_domains_dynamodb',
        Key: { DomainName: 'avengers.org' }
      })
    })

    it('should return false if domain is not restricted', async () => {
      mockDynamoDBSend.mockResolvedValue({})
      const result = await RestrictedDomains.isRestricted('tony.stark@avengers.org')
      expect(result).toBeFalsy()
    })
  })

  describe('allDomains()', () => {
    it('should return an array of all domains from DynamoDB', async () => {
      mockDynamoDBSend.mockResolvedValue({ Items: [{ DomainName: 'cru.org' }, { DomainName: 'avengers.org' }] })
      const result = await new RestrictedDomains().allDomains()
      expect(result).toEqual(['cru.org', 'avengers.org'])
      expect(ScanCommand).toHaveBeenCalledWith({ TableName: 'restricted_domains_dynamodb' })
    })
  })

  describe('googleSheetDomains()', () => {
    it('should return an array of all the domains in the google sheet', async () => {
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
    it('should successfully update DynamoDB with changes from Google', async () => {
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
