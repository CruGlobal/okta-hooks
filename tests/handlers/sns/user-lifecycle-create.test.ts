import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handler } from '@/handlers/sns/user-lifecycle-create.js'
import rollbar from '@/config/rollbar.js'
import { Client, mockGetUser, mockUpdateUser, mockUnassignUserFromGroup } from '../../mocks/okta-sdk-nodejs.js'
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
  return { Client: mock.Client, mockGetUser: mock.mockGetUser, mockUnassignUserFromGroup: mock.mockUnassignUserFromGroup }
})

describe('user.lifecycle.create SNS message', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('OKTA_MISSING_GROUP_ID', 'test-group-id')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not persist GUID if user already has `theKeyGuid`', async () => {
    const profile = { theKeyGuid: '58ae8a88-878c-47a8-a22e-543665b7fe33' }
    mockCreateOrUpdateProfile.mockResolvedValue(true)
    mockGetUser.mockResolvedValue({ status: 'ACTIVE', profile })
    await handler(created as any)
    expect(Client).toHaveBeenCalled()
    expect(mockGetUser).toHaveBeenCalledWith({ userId: '00uo1red47olcenOx0h7' })
    expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith(profile)
    expect(mockUpdateUser).toHaveBeenCalledTimes(1)
  })

  it('skips Okta update when GR profile is unchanged', async () => {
    const profile = { theKeyGuid: '58ae8a88-878c-47a8-a22e-543665b7fe33' }
    mockCreateOrUpdateProfile.mockResolvedValue(false)
    mockGetUser.mockResolvedValue({ profile })
    await handler(created as any)
    expect(mockCreateOrUpdateProfile).toHaveBeenCalledWith(profile)
    expect(mockUpdateUser).not.toHaveBeenCalled()
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

  it('throws if Okta returns a user with no profile', async () => {
    mockGetUser.mockResolvedValue({})
    await expect(handler(created as any)).rejects.toThrow('Okta user 00uo1red47olcenOx0h7 has no profile')
    expect(mockCreateOrUpdateProfile).not.toHaveBeenCalled()
    expect(mockUpdateUser).not.toHaveBeenCalled()
    expect(rollbar.error).toHaveBeenCalled()
  })

  it('removes deprovisioned user from missing group and skips processing', async () => {
    mockGetUser.mockResolvedValue({ status: 'DEPROVISIONED', profile: {} })
    await handler(created as any)
    expect(mockUnassignUserFromGroup).toHaveBeenCalledWith({
      groupId: 'test-group-id',
      userId: '00uo1red47olcenOx0h7'
    })
    expect(mockCreateOrUpdateProfile).not.toHaveBeenCalled()
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('throws if OKTA_MISSING_GROUP_ID is not set when handling a deprovisioned user', async () => {
    vi.stubEnv('OKTA_MISSING_GROUP_ID', '')
    mockGetUser.mockResolvedValue({ status: 'DEPROVISIONED', profile: {} })
    await expect(handler(created as any)).rejects.toThrow('OKTA_MISSING_GROUP_ID is not set')
    expect(mockUnassignUserFromGroup).not.toHaveBeenCalled()
    expect(rollbar.error).toHaveBeenCalled()
  })

  it('should return an error', async () => {
    mockGetUser.mockRejectedValue(new Error('Ohh noes!!'))
    await expect(handler(created as any)).rejects.toThrow('Ohh noes!!')
    expect(rollbar.error).toHaveBeenCalled()
  })
})

// Regression guard for the 2026-09-16 finding: a live Global Registry bearer
// token reached Datadog in plaintext. request-promise attaches the outbound
// request (Authorization header included) to the errors it throws; this handler
// rethrows, and the Lambda runtime serialises the whole object into its log line.
describe('credential redaction on failure', () => {
  const grErrorWithToken = () => {
    const error = new Error('400 - {"error":"Another entity exists"}') as Error & Record<string, any>
    error.name = 'StatusCodeError'
    error.options = { headers: { Authorization: 'Bearer LIVE-GR-TOKEN' }, uri: '/entities/' }
    error.response = { request: { headers: { Authorization: 'Bearer LIVE-GR-TOKEN' } } }
    return error
  }

  it('strips the bearer token from the error it rethrows and reports', async () => {
    mockGetUser.mockResolvedValue({ status: 'ACTIVE', profile: {} })
    mockCreateOrUpdateProfile.mockRejectedValue(grErrorWithToken())

    const thrown = await handler(created as any).then(
      () => { throw new Error('handler was expected to rethrow') },
      (e) => e
    )

    // What the Lambda runtime would serialise into its "Invoke Error" line.
    expect(JSON.stringify(thrown)).not.toContain('LIVE-GR-TOKEN')
    expect(thrown.options.headers.Authorization).toBe('[REDACTED]')
    expect(thrown.response.request.headers.Authorization).toBe('[REDACTED]')
    // Still diagnosable.
    expect(thrown.options.uri).toBe('/entities/')
    expect(thrown.message).toContain('Another entity exists')

    // And what was sent to Rollbar.
    const reported = vi.mocked(rollbar.error).mock.calls[0][1]
    expect(JSON.stringify(reported)).not.toContain('LIVE-GR-TOKEN')
  })
})
