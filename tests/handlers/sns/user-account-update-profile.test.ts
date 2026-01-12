import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handler } from '@/handlers/sns/user-account-update-profile.js'
import rollbar from '@/config/rollbar.js'
import { mockGetUser } from '../../mocks/okta-sdk-nodejs.js'
import GlobalRegistry from '@/models/global-registry.js'
import { v4 as uuid } from 'uuid'

import updateProfileEvent from '../../fixtures/sns/user-account-update-profile.json'

const mockCreateOrUpdateProfile = vi.fn()

vi.mock('@/config/rollbar.js')
vi.mock('@/models/global-registry.js', () => ({
  default: vi.fn(() => ({
    createOrUpdateProfile: mockCreateOrUpdateProfile
  }))
}))
vi.mock('@okta/okta-sdk-nodejs', async () => {
  const mock = await import('../../mocks/okta-sdk-nodejs.js')
  return { Client: mock.Client, mockGetUser: mock.mockGetUser }
})

describe('user.account.update_profile SNS message', () => {
  let profile: Record<string, unknown>, mockUpdate: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.clearAllMocks()
    profile = { login: 'ronin@avangers.org', email: 'hawkeye@avengers.org' }
    mockUpdate = vi.fn()
    mockGetUser.mockResolvedValue({
      profile,
      status: 'ACTIVE',
      update: mockUpdate
    })
  })

  it('should update user if login/email has changed', async () => {
    await handler(updateProfileEvent as any)
    expect(GlobalRegistry).toHaveBeenCalledWith('secret', 'https://example.com')
    expect(mockGetUser).toHaveBeenCalledWith({ userId: '00uo48gsq4ujEWoXJ0h7' })
    expect(profile.email).toEqual(profile.login)
    expect(mockCreateOrUpdateProfile).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('should update user if profile was updated', async () => {
    mockCreateOrUpdateProfile.mockResolvedValue(true)
    profile.theKeyGuid = uuid()
    await handler({ Records: [{ Sns: { Message: JSON.stringify({ debugContext: { debugData: { changedAttributes: 'firstName' } } }) } }] } as any)
    expect(mockGetUser).toHaveBeenCalled()
    expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith(profile)
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('should do nothing if nothing was changed', async () => {
    mockCreateOrUpdateProfile.mockResolvedValue(false)
    profile.theKeyGuid = uuid()
    await handler({ Records: [{ Sns: { Message: JSON.stringify({ debugContext: { debugData: { changedAttributes: 'firstName' } } }) } }] } as any)
    expect(mockGetUser).toHaveBeenCalled()
    expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith(profile)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('should do nothing if login and email are the same', async () => {
    profile.login = 'hawkeye@avengers.org'
    await handler(updateProfileEvent as any)
    expect(mockGetUser).toHaveBeenCalledWith({ userId: '00uo48gsq4ujEWoXJ0h7' })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('should report error to rollbar', async () => {
    mockGetUser.mockRejectedValue(new Error('Ohh noes!!'))
    await expect(handler(updateProfileEvent as any)).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})
