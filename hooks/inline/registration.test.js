import { handler } from './registration'
import GUID from '../../models/guid'
import rollbar from '../../config/rollbar'
import RestrictedDomain from '../../models/restricted-domain'

jest.mock('../../config/rollbar')

const registrationEvent = require('../../tests/fixtures/alb/inline-registration')

describe('registration hook', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  it('should respond with command to add `theKeyGuid` profile attribute', async () => {
    jest.spyOn(GUID, 'create').mockReturnValue('00000000-0000-0000-0000-000000000000')
    jest.spyOn(RestrictedDomain, 'isRestricted').mockResolvedValue(false)
    const response = await handler(registrationEvent)
    expect(RestrictedDomain.isRestricted).toHaveBeenCalledWith('tony.stark@avengers.org')
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
          value: { theKeyGuid: '00000000-0000-0000-0000-000000000000' }
        }]
      })
    })
  })

  it('should return an error when email is restricted', async () => {
    jest.spyOn(RestrictedDomain, 'isRestricted').mockResolvedValue(true)
    const response = await handler(registrationEvent)
    expect(RestrictedDomain.isRestricted).toHaveBeenCalledWith('tony.stark@avengers.org')
    expect(response).toStrictEqual({
      statusCode: 200,
      statusDescription: '200 OK',
      isBase64Encoded: false,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        error: {
          errorSummary: 'Errors were found in the user profile',
          errorCauses: [{
            locationType: 'body',
            location: 'data.userProfile.email',
            domain: 'end-user',
            errorSummary: 'You specified a restricted email domain. Please contact <a href="mailto:help@cru.org">help@cru.org</a> to set-up this account.',
            reason: 'RESTRICTED_EMAIL_DOMAIN'
          }]
        }
      })
    })
  })

  it('should log to rollbar on error and return success to okta', async () => {
    jest.spyOn(GUID, 'create').mockImplementation(() => {
      throw new Error('Ohh noes!!')
    })
    const response = await handler(registrationEvent)
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
})
