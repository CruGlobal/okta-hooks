import RegistrationRequest from './registration-request'

const inlineRegistration = require('../tests/fixtures/alb/inline-registration.json')

describe('RegistrationRequest', () => {
  describe('constructor(json)', () => {
    it('constructs a new object', () => {
      const registrationRequest = new RegistrationRequest(inlineRegistration.body)
      expect(registrationRequest).toEqual(expect.any(RegistrationRequest))
      expect(registrationRequest.email).toEqual('tony.stark@avengers.org')
      expect(registrationRequest.login).toEqual('tony.stark@avengers.org')
      expect(registrationRequest.firstName).toEqual('Tony')
      expect(registrationRequest.lastName).toEqual('Stark')
    })
  })
})
