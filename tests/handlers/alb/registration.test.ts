import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handler } from '@/handlers/alb/registration.js'
import GUID from '@/models/guid.js'
import rollbar from '@/config/rollbar.js'
import RestrictedDomains from '@/models/restricted-domains.js'

import registrationEvent from '../../fixtures/alb/inline-registration.json'

vi.mock('@/config/rollbar.js')

describe('registration hook', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('should respond with command to add `theKeyGuid` profile attribute', async () => {
    vi.spyOn(GUID, 'create').mockReturnValue('00000000-0000-0000-0000-000000000000')
    vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(false)
    const response = await handler(registrationEvent as any)
    expect(RestrictedDomains.isRestricted).toHaveBeenCalledWith('tony.stark@avengers.org')
    expect(GUID.create).toHaveBeenCalled()
    expect(response).toStrictEqual({
      statusCode: 200,
      statusDescription: '200 OK',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        commands: [{
          type: 'com.okta.user.profile.update',
          value: { theKeyGuid: '00000000-0000-0000-0000-000000000000', orca: false }
        }]
      })
    })
  })

  it('should return an error when email is restricted', async () => {
    vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(true)
    const response = await handler(registrationEvent as any)
    expect(RestrictedDomains.isRestricted).toHaveBeenCalledWith('tony.stark@avengers.org')
    expect(response).toStrictEqual({
      statusCode: 200,
      statusDescription: '200 OK',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        commands: [{
          type: 'com.okta.action.update',
          value: { registration: 'DENY' }
        }],
        error: {
          errorSummary: 'Errors were found in the user profile',
          errorCauses: [{
            locationType: 'body',
            location: 'data.userProfile.login',
            domain: 'end-user',
            errorSummary: 'help@checkmyokta.com must be contacted before this email domain can be used.',
            reason: 'RESTRICTED_EMAIL_DOMAIN'
          }]
        }
      })
    })
  })

  it('should log to rollbar on error and return success to okta', async () => {
    vi.spyOn(GUID, 'create').mockImplementation(() => {
      throw new Error('Ohh noes!!')
    })
    const response = await handler(registrationEvent as any)
    expect(response).toStrictEqual({
      statusCode: 204,
      statusDescription: '204 No Content',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    })
    expect(rollbar.error)
      .toHaveBeenCalledWith('registration hook Error', expect.any(Error), { lambdaEvent: registrationEvent })
  })

  it('should handle null body gracefully', async () => {
    const eventWithNullBody = { ...registrationEvent, body: null }
    const response = await handler(eventWithNullBody as any)
    expect(response).toStrictEqual({
      statusCode: 204,
      statusDescription: '204 No Content',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    })
    expect(rollbar.error).toHaveBeenCalledWith(
      'registration hook Error',
      expect.any(Error),
      { lambdaEvent: eventWithNullBody }
    )
  })
})
