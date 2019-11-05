import { handler } from './status-change'
import rollbar from '../../../config/rollbar'
import { mockGetUser } from '@okta/okta-sdk-nodejs'

const mockCreateOrUpdateProfile = jest.fn()
const mockDeleteProfile = jest.fn()
jest.mock('../../../config/rollbar')
jest.mock('../../../models/global-registry', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    createOrUpdateProfile: mockCreateOrUpdateProfile,
    deleteProfile: mockDeleteProfile.mockResolvedValue(true)
  }))
}))

const deactivateEvent = require('../../../tests/fixtures/sns/user-lifecycle-deactivate.json')
const reactivateEvent = require('../../../tests/fixtures/sns/user-lifecycle-reactivate.json')
const mockUpdate = jest.fn()

describe('status change handler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('user.lifecycle.deactivate SNS message', () => {
    it('should delete profile from GR', async () => {
      mockGetUser.mockResolvedValue({
        status: 'DEPROVISIONED',
        profile: {},
        update: mockUpdate
      })

      await handler(deactivateEvent)
      expect(mockGetUser).toHaveBeenCalledWith('00uo1red47olcenOx0h7')
      expect(mockDeleteProfile).toHaveBeenCalledWith({})
      expect(mockUpdate).toHaveBeenCalled()
    })
  })

  describe('user.lifecycle.reactivate SNS message', () => {
    it('should create profile in GR', async () => {
      mockGetUser.mockResolvedValue({
        status: 'ACTIVE',
        profile: {},
        update: mockUpdate
      })
      mockCreateOrUpdateProfile.mockResolvedValue(false)

      await handler(reactivateEvent)
      expect(mockGetUser).toHaveBeenCalledWith('00uo1red47olcenOx0h7')
      expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith({})
      expect(mockUpdate).not.toHaveBeenCalled()
    })
  })

  it('should send error to rollbar', async () => {
    mockGetUser.mockRejectedValue(new Error('Ohh noes!!'))
    await expect(handler(deactivateEvent)).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})
