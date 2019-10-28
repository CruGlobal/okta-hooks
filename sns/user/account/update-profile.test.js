import { handler } from './update-profile'
import rollbar from '../../../config/rollbar'
import { mockGetUser } from '@okta/okta-sdk-nodejs'

jest.mock('../../../config/rollbar')

const updateProfileEvent = require('../../../tests/fixtures/sns/user-account-update-profile.json')

describe('user.account.update_profile SNS message', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should update email if login has changed', async () => {
    const mockUpdate = jest.fn().mockResolvedValue({})
    const profile = { login: 'ronin@avangers.org', email: 'hawkeye@avengers.org' }
    mockGetUser.mockResolvedValue({
      profile,
      update: mockUpdate
    })
    await handler(updateProfileEvent)
    expect(mockGetUser).toHaveBeenCalledWith('00uo48gsq4ujEWoXJ0h7')
    expect(profile.email).toEqual(profile.login)
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('should do nothing if login did not change', async () => {
    await handler({ Records: [{ Sns: { Message: JSON.stringify({ debugContext: { debugData: { changedAttributes: 'firstName' } } }) } }] })
    expect(mockGetUser).not.toHaveBeenCalled()
  })

  it('should do nothing if login and email are the same', async () => {
    const mockUpdate = jest.fn().mockResolvedValue({})
    const profile = { login: 'ronin@avangers.org', email: 'ronin@avangers.org' }
    mockGetUser.mockResolvedValue({
      profile,
      update: mockUpdate
    })
    await handler(updateProfileEvent)
    expect(mockGetUser).toHaveBeenCalledWith('00uo48gsq4ujEWoXJ0h7')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('should report error to rollbar', async () => {
    mockGetUser.mockRejectedValue(new Error('Ohh noes!!'))
    await expect(handler(updateProfileEvent)).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})
