import { handler } from './registration'
import uuid from 'uuid/v4'

jest.mock('uuid/v4')

describe('registration hook', () => {
  beforeEach(() => {
    jest.resetAllMocks()
  })

  it('should respond with command to add `theKeyGuid` profile attribute', async () => {
    uuid.mockReturnValue('00000000-0000-0000-0000-000000000000')
    const registrationEvent = require('../../tests/fixtures/registration-event')
    const response = await handler(registrationEvent)
    expect(uuid).toHaveBeenCalled()
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
})
