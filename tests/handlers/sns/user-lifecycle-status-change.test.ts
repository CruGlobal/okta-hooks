import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handler } from '@/handlers/sns/user-lifecycle-status-change.js'
import rollbar from '@/config/rollbar.js'
import { mockGetUser, mockUpdateUser } from '../../mocks/okta-sdk-nodejs.js'

import deactivateEvent from '../../fixtures/sns/user-lifecycle-deactivate.json'
import reactivateEvent from '../../fixtures/sns/user-lifecycle-reactivate.json'

const mockCreateOrUpdateProfile = vi.fn()
const mockDeleteProfile = vi.fn()

vi.mock('@/config/rollbar.js')
vi.mock('@/models/global-registry.js', () => ({
  default: vi.fn(() => ({
    createOrUpdateProfile: mockCreateOrUpdateProfile,
    deleteProfile: mockDeleteProfile.mockResolvedValue(true)
  }))
}))
vi.mock('@okta/okta-sdk-nodejs', async () => {
  const mock = await import('../../mocks/okta-sdk-nodejs.js')
  return { Client: mock.Client, mockGetUser: mock.mockGetUser, mockUpdateUser: mock.mockUpdateUser }
})

describe('status change handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('user.lifecycle.deactivate SNS message', () => {
    it('should delete profile from GR', async () => {
      mockGetUser.mockResolvedValue({
        status: 'DEPROVISIONED',
        profile: {}
      })

      await handler(deactivateEvent as any)
      expect(mockGetUser).toHaveBeenCalledWith({ userId: '00uo1red47olcenOx0h7' })
      expect(mockDeleteProfile).toHaveBeenCalledWith({})
      expect(mockUpdateUser).not.toHaveBeenCalled()
    })
  })

  describe('user.lifecycle.reactivate SNS message', () => {
    it('should create profile in GR', async () => {
      const user = { status: 'ACTIVE', profile: {} }
      mockGetUser.mockResolvedValue(user)
      mockCreateOrUpdateProfile.mockResolvedValue(false)

      await handler(reactivateEvent as any)
      expect(mockGetUser).toHaveBeenCalledWith({ userId: '00uo1red47olcenOx0h7' })
      expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith({})
      expect(mockUpdateUser).not.toHaveBeenCalled()
    })

    it('should update okta user when profile was modified in GR', async () => {
      const user = { status: 'ACTIVE', profile: {} }
      mockGetUser.mockResolvedValue(user)
      mockCreateOrUpdateProfile.mockResolvedValue(true)

      await handler(reactivateEvent as any)
      expect(mockGetUser).toHaveBeenCalledWith({ userId: '00uo1red47olcenOx0h7' })
      expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith({})
      expect(mockUpdateUser).toHaveBeenCalledWith({ userId: '00uo1red47olcenOx0h7', user })
    })
  })

  it('should send error to rollbar', async () => {
    mockGetUser.mockRejectedValue(new Error('Ohh noes!!'))
    await expect(handler(deactivateEvent as any)).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})
