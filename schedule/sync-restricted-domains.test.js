import { handler } from './sync-restricted-domains'
import RestrictedDomains from '../models/restricted-domains'
import rollbar from '../config/rollbar'

jest.mock('../config/rollbar')
const mockSyncDomainsFromGoogle = jest.fn()
jest.mock('../models/restricted-domains', () => jest.fn().mockImplementation(() => ({
  syncDomainsFromGoogle: mockSyncDomainsFromGoogle
})))

describe('sync-restricted-domains handler', () => {
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
