import RestrictedDomains from './restricted-domains'
import { DynamoDB } from 'aws-sdk'
import { google, mockSpreadsheetsGet } from 'googleapis'

const DocumentClient = DynamoDB.DocumentClient

describe('RestrictedDomains', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('static isRestricted(domain)', () => {
    it('should be true when domain name is restricted', async () => {
      DocumentClient._getPromiseMock.mockResolvedValue({ Item: { DomainName: 'avengers.org' } })
      const result = await RestrictedDomains.isRestricted('tony.stark@avengers.org')
      expect(result).toBeTruthy()
      expect(DocumentClient).toHaveBeenCalled()
      expect(DocumentClient._getMock).toHaveBeenCalledWith({
        TableName: 'restricted_domains_dynamodb',
        Key: { DomainName: 'avengers.org' }
      })
    })

    it('should return false if domain is not restricted', async () => {
      DocumentClient._getPromiseMock.mockResolvedValue({})
      const result = await RestrictedDomains.isRestricted('tony.stark@avengers.org')
      expect(result).toBeFalsy()
    })
  })

  describe('allDomains()', () => {
    it('should return an array of all domains from DynamoDB', async () => {
      DocumentClient._scanPromiseMock.mockResolvedValue({ Items: [{ DomainName: 'cru.org' }, { DomainName: 'avengers.org' }] })
      const result = await new RestrictedDomains().allDomains()
      expect(result).toEqual(['cru.org', 'avengers.org'])
      expect(DocumentClient._scanMock).toHaveBeenCalledWith({ TableName: 'restricted_domains_dynamodb' })
    })
  })

  describe('googleSheetDomains()', () => {
    it('should return an array of all the domains in the google sheet', async () => {
      mockSpreadsheetsGet.mockResolvedValue({ data: { values: [['cru.org'], ['Avengers.org'], ['example.com']] } })
      const result = await new RestrictedDomains().googleSheetDomains()
      expect(result).toEqual(['cru.org', 'avengers.org', 'example.com'])
      expect(google.auth.JWT).toHaveBeenCalledWith({
        email: 'client@okta-hooks.example.com',
        key: `-----BEGIN PRIVATE KEY-----\nabcdefg\n`,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
      })
      expect(google.sheets).toHaveBeenCalledWith({ version: 'v4', auth: google.auth.JWT.mock.instances[0] })
      expect(mockSpreadsheetsGet).toHaveBeenCalledWith({
        spreadsheetId: 'google_spreadsheet',
        range: 'A2:A'
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
            ['example.com']]
        }
      })
      DocumentClient._scanPromiseMock.mockResolvedValue({
        Items: [
          { DomainName: 'cru.org' },
          { DomainName: 'avengers.org' },
          { DomainName: 'ccci.org' }
        ]
      })
      DocumentClient._batchWritePromiseMock.mockResolvedValue({})
      await new RestrictedDomains().syncDomainsFromGoogle()
      expect(DocumentClient._batchWriteMock).toHaveBeenCalledWith({
        RequestItems: {
          'restricted_domains_dynamodb': [
            { PutRequest: { Item: { DomainName: 'example.com' } } },
            { DeleteRequest: { Key: { DomainName: 'ccci.org' } } }
          ]
        }
      })
    })

    it('does nothing if there are no changes', async () => {
      mockSpreadsheetsGet.mockResolvedValue({ data: { values: [['cru.org']] } })
      DocumentClient._scanPromiseMock.mockResolvedValue({ Items: [{ DomainName: 'cru.org' }] })
      await new RestrictedDomains().syncDomainsFromGoogle()
      expect(DocumentClient._batchWriteMock).not.toHaveBeenCalled()
    })
  })
})
