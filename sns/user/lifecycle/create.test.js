import { handler } from './create'
import rollbar from '../../../config/rollbar'
import { Client, mockGetUser } from '@okta/okta-sdk-nodejs'
import GUID from '../../../models/guid'

jest.mock('../../../config/rollbar')
jest.mock('@okta/okta-sdk-nodejs')

const created = require('../../../tests/fixtures/sns/user-lifecycle-create')

describe('user.lifecycle.create SNS message', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does nothing if user already has `theKeyGuid`', async () => {
    const mockUpdate = jest.fn()
    mockGetUser.mockResolvedValue({
      profile: { theKeyGuid: '58ae8a88-878c-47a8-a22e-543665b7fe33' },
      update: mockUpdate
    })
    await handler(created)
    expect(Client).toHaveBeenCalled()
    expect(mockGetUser).toHaveBeenCalledWith('00uo1red47olcenOx0h7')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('updates user profile with new `theKeyGuid` if its missing', async () => {
    jest.spyOn(GUID, 'create').mockReturnValue('58ae8a88-878c-47a8-a22e-543665b7fe33')
    const mockUpdate = jest.fn().mockResolvedValue({})
    const profile = {}
    mockGetUser.mockResolvedValue({
      profile,
      update: mockUpdate
    })
    await handler(created)
    expect(profile.theKeyGuid).toEqual('58ae8a88-878c-47a8-a22e-543665b7fe33')
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('should return an error', async () => {
    mockGetUser.mockRejectedValue(new Error('Ohh noes!!'))
    await expect(handler(created)).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})
