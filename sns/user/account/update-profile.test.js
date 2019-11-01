import { handler } from './update-profile'
import rollbar from '../../../config/rollbar'
import { mockGetUser } from '@okta/okta-sdk-nodejs'
import GlobalRegistry from '../../../models/global-registry'
import uuid from 'uuid/v4'

const mockUpdateProfile = jest.fn()
jest.mock('../../../config/rollbar')
jest.mock('../../../models/global-registry', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    updateProfile: mockUpdateProfile
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
      update: mockUpdate
    })
  })

  it('should update user if login/email has changed', async () => {
    await handler(updateProfileEvent)
    expect(mockGetUser).toHaveBeenCalledWith('00uo48gsq4ujEWoXJ0h7')
    expect(profile.email).toEqual(profile.login)
    expect(mockUpdateProfile).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('should update user if profile was updated', async () => {
    mockUpdateProfile.mockResolvedValue(true)
    profile.theKeyGuid = uuid()
    await handler({ Records: [{ Sns: { Message: JSON.stringify({ debugContext: { debugData: { changedAttributes: 'firstName' } } }) } }] })
    expect(mockGetUser).toHaveBeenCalled()
    expect(mockUpdateProfile).toHaveBeenCalledWith(profile)
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('should do nothing if nothing was changed', async () => {
    mockUpdateProfile.mockResolvedValue(false)
    profile.theKeyGuid = uuid()
    await handler({ Records: [{ Sns: { Message: JSON.stringify({ debugContext: { debugData: { changedAttributes: 'firstName' } } }) } }] })
    expect(mockGetUser).toHaveBeenCalled()
    expect(mockUpdateProfile).toHaveBeenCalledWith(profile)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('should do nothing if login and email are the same', async () => {
    profile.login = 'hawkeye@avengers.org'
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
