import { handler } from './update-profile'
import rollbar from '../../../config/rollbar'
import { mockGetUser } from '@okta/okta-sdk-nodejs'
import GlobalRegistry from '../../../models/global-registry'
import GUID from '../../../models/guid'
import { v4 as uuid } from 'uuid'

const mockCreateOrUpdateProfile = jest.fn()
jest.mock('../../../config/rollbar')
jest.mock('../../../models/global-registry', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    createOrUpdateProfile: mockCreateOrUpdateProfile
  }))
}))

const updateProfileEvent = require('../../../tests/fixtures/sns/user-account-update-profile.json')

describe('user.account.update_profile SNS message', () => {
  let profile, mockUpdate
  beforeEach(() => {
    jest.clearAllMocks()
    profile = { login: 'ronin@avangers.org', email: 'hawkeye@avengers.org' }
    mockUpdate = jest.fn()
    mockGetUser.mockResolvedValue({
      profile,
      status: 'ACTIVE',
      update: mockUpdate
    })
  })

  it('should update user if login/email has changed', async () => {
    profile.theKeyGuid = uuid()
    mockCreateOrUpdateProfile.mockResolvedValue(false)
    await handler(updateProfileEvent)
    expect(GlobalRegistry).toHaveBeenCalledWith('secret', 'https://example.com')
    expect(mockGetUser).toHaveBeenCalledWith('00uo48gsq4ujEWoXJ0h7')
    expect(profile.email).toEqual(profile.login)
    expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith(profile)
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('should update user if profile was updated', async () => {
    mockCreateOrUpdateProfile.mockResolvedValue(true)
    profile.theKeyGuid = uuid()
    await handler({ Records: [{ Sns: { Message: JSON.stringify({ debugContext: { debugData: { changedAttributes: 'firstName' } } }) } }] })
    expect(mockGetUser).toHaveBeenCalled()
    expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith(profile)
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('should do nothing if nothing was changed', async () => {
    mockCreateOrUpdateProfile.mockResolvedValue(false)
    profile.theKeyGuid = uuid()
    await handler({ Records: [{ Sns: { Message: JSON.stringify({ debugContext: { debugData: { changedAttributes: 'firstName' } } }) } }] })
    expect(mockGetUser).toHaveBeenCalled()
    expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith(profile)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('should generate theKeyGuid if missing', async () => {
    jest.spyOn(GUID, 'create').mockReturnValue('58ae8a88-878c-47a8-a22e-543665b7fe33')
    mockCreateOrUpdateProfile.mockResolvedValue(false)
    await handler({ Records: [{ Sns: { Message: JSON.stringify({ debugContext: { debugData: { changedAttributes: 'Notes' } } }) } }] })
    expect(mockGetUser).toHaveBeenCalled()
    expect(profile.theKeyGuid).toEqual('58ae8a88-878c-47a8-a22e-543665b7fe33')
    expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith(profile)
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('should do nothing if login and email are the same', async () => {
    profile.login = 'hawkeye@avengers.org'
    profile.theKeyGuid = uuid()
    mockCreateOrUpdateProfile.mockResolvedValue(false)
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
