import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handler } from '@/handlers/sns/user-lifecycle-create.js'
import rollbar from '@/config/rollbar.js'
import { Client, mockGetUser, mockUpdateUser } from '../../mocks/okta-sdk-nodejs.js'
import GUID from '@/models/guid.js'

import created from '../../fixtures/sns/user-lifecycle-create.json'

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

describe('user.lifecycle.create SNS message', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not persist GUID if user already has `theKeyGuid`', async () => {
    const profile = { theKeyGuid: '58ae8a88-878c-47a8-a22e-543665b7fe33' }
    mockCreateOrUpdateProfile.mockResolvedValue(true)
    mockGetUser.mockResolvedValue({ profile })
    await handler(created as any)
    expect(Client).toHaveBeenCalled()
    expect(mockGetUser).toHaveBeenCalledWith({ userId: '00uo1red47olcenOx0h7' })
    expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith(profile)
    expect(mockUpdateUser).toHaveBeenCalledTimes(1)
  })

  it('generates and persists theKeyGuid before calling GR', async () => {
    vi.spyOn(GUID, 'create').mockReturnValue('58ae8a88-878c-47a8-a22e-543665b7fe33')
    mockCreateOrUpdateProfile.mockResolvedValue(true)
    const profile: Record<string, unknown> = {}
    const user = { profile }
    mockGetUser.mockResolvedValue(user)
    await handler(created as any)
    expect(profile.theKeyGuid).toEqual('58ae8a88-878c-47a8-a22e-543665b7fe33')
    expect(mockUpdateUser).toHaveBeenCalledTimes(2)
    expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith(profile)
  })

  it('persists theKeyGuid even when GR call fails', async () => {
    vi.spyOn(GUID, 'create').mockReturnValue('58ae8a88-878c-47a8-a22e-543665b7fe33')
    mockCreateOrUpdateProfile.mockRejectedValue(new Error('GR failed'))
    const profile: Record<string, unknown> = {}
    const user = { profile }
    mockGetUser.mockResolvedValue(user)
    await expect(handler(created as any)).rejects.toThrow('GR failed')
    expect(profile.theKeyGuid).toEqual('58ae8a88-878c-47a8-a22e-543665b7fe33')
    expect(mockUpdateUser).toHaveBeenCalledTimes(1)
    expect(mockUpdateUser).toHaveBeenCalledWith({ userId: '00uo1red47olcenOx0h7', user })
  })

  it('should return an error', async () => {
    mockGetUser.mockRejectedValue(new Error('Ohh noes!!'))
    await expect(handler(created as any)).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})
