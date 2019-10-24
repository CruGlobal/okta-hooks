import { handler } from './registration'
import GUID from '../../models/guid'
import rollbar from '../../config/rollbar'

jest.mock('../../config/rollbar')

const registrationEvent = require('../../tests/fixtures/alb/inline-registration')

describe('registration hook', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  it('should respond with command to add `theKeyGuid` profile attribute', async () => {
    jest.spyOn(GUID, 'create').mockReturnValue('00000000-0000-0000-0000-000000000000')
    const response = await handler(registrationEvent)
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
