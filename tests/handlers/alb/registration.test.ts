import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ALBResult } from 'aws-lambda'
import { handler } from '@/handlers/alb/registration.js'
import GUID from '@/models/guid.js'
import rollbar from '@/config/rollbar.js'
import RestrictedDomains from '@/models/restricted-domains.js'
import { REDACTED } from '@/utils/redact-error.js'

import registrationEvent from '../../fixtures/alb/inline-registration.json'

vi.mock('@/config/rollbar.js')

const GUID_VALUE = '00000000-0000-0000-0000-000000000000'
const ALLOW = { type: 'com.okta.action.update', value: { registration: 'ALLOW' } }
const DENY = { type: 'com.okta.action.update', value: { registration: 'DENY' } }
const RESTRICTED_ERROR = 'help@checkmyokta.com must be contacted before this email domain can be used.'
const TRY_AGAIN_ERROR = "We couldn't finish creating your account. Please try again in a few minutes."

const withLocale = (locale: string) => ({ ...registrationEvent, headers: { ...registrationEvent.headers, 'x-cru-locale': locale } })
const bodyOf = (response: ALBResult) => JSON.parse(response.body ?? '')
const never = () => new Promise<never>(() => {})
const tryAgainBody = (errorSummary = TRY_AGAIN_ERROR) => ({
  commands: [DENY],
  error: {
    errorSummary: 'Errors were found in the user profile',
    errorCauses: [{
      locationType: 'body',
      location: 'data.userProfile.login',
      domain: 'end-user',
      errorSummary,
      reason: 'RESTRICTED_DOMAIN_CHECK_UNAVAILABLE'
    }]
  }
})

// Starts the handler and records when it settles, so a test can advance fake
// timers and check the hook answered inside the budget.
const startHandler = (event: unknown) => {
  const state = { settled: false }
  const result = handler(event as any).finally(() => {
    state.settled = true
  })
  return { state, result }
}

describe('registration hook', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.mocked(rollbar.error).mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should allow the registration and add the `theKeyGuid` profile attribute', async () => {
    vi.spyOn(GUID, 'create').mockReturnValue(GUID_VALUE)
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
        commands: [
          ALLOW,
          {
            type: 'com.okta.user.profile.update',
            value: { theKeyGuid: GUID_VALUE, orca: false }
          }
        ]
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
        commands: [DENY],
        error: {
          errorSummary: 'Errors were found in the user profile',
          errorCauses: [{
            locationType: 'body',
            location: 'data.userProfile.login',
            domain: 'end-user',
            errorSummary: RESTRICTED_ERROR,
            reason: 'RESTRICTED_EMAIL_DOMAIN'
          }]
        }
      })
    })
  })

  describe('X-Cru-Locale header', () => {
    it.each(['fr_FR', 'pt_BR', 'de_DE', 'es_MX', 'zh_TW'])('should add the allowed locale %s to the profile update', async (locale) => {
      vi.spyOn(GUID, 'create').mockReturnValue(GUID_VALUE)
      vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(false)
      const response = await handler(withLocale(locale) as any)
      expect(bodyOf(response)).toStrictEqual({
        commands: [
          ALLOW,
          {
            type: 'com.okta.user.profile.update',
            value: { theKeyGuid: GUID_VALUE, orca: false, locale }
          }
        ]
      })
    })

    it.each([
      ['fr_FR', "Veuillez contacter help@checkmyokta.com avant d'utiliser ce domaine de messagerie."],
      ['pt_BR', 'Entre em contato com help@checkmyokta.com antes de usar este domínio de e-mail.']
    ])('should return the restricted domain error for %s in that language', async (locale, errorSummary) => {
      vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(true)
      const response = await handler(withLocale(locale) as any)
      const body = bodyOf(response)
      expect(body.commands).toStrictEqual([DENY])
      expect(body.error.errorCauses[0].errorSummary).toBe(errorSummary)
    })

    it('should return the English error for an allowed locale with no translated error', async () => {
      vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(true)
      const response = await handler(withLocale('de_DE') as any)
      expect(bodyOf(response).error.errorCauses[0].errorSummary).toBe(RESTRICTED_ERROR)
    })

    it.each(['en_US', 'pt_PT', 'fr-FR', 'fr_fr', 'xx_XX'])('should ignore the locale %s, which is not allowed', async (locale) => {
      vi.spyOn(GUID, 'create').mockReturnValue(GUID_VALUE)
      vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(false)
      const response = await handler(withLocale(locale) as any)
      expect(bodyOf(response).commands).toStrictEqual([
        ALLOW,
        { type: 'com.okta.user.profile.update', value: { theKeyGuid: GUID_VALUE, orca: false } }
      ])
    })

    it('should keep the English error for a locale that is not allowed', async () => {
      vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(true)
      const response = await handler(withLocale('xx_XX') as any)
      expect(bodyOf(response).error.errorCauses[0].errorSummary).toBe(RESTRICTED_ERROR)
    })

    it('should work when the ALB event has no headers', async () => {
      vi.spyOn(GUID, 'create').mockReturnValue(GUID_VALUE)
      vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(false)
      const { headers: _unused, ...eventWithoutHeaders } = registrationEvent
      const response = await handler(eventWithoutHeaders as any)
      expect(bodyOf(response).commands).toStrictEqual([
        ALLOW,
        { type: 'com.okta.user.profile.update', value: { theKeyGuid: GUID_VALUE, orca: false } }
      ])
    })
  })

  describe('when the restricted domain check fails', () => {
    it('should deny with the try again error when the lookup rejects', async () => {
      vi.spyOn(GUID, 'create').mockReturnValue(GUID_VALUE)
      vi.spyOn(RestrictedDomains, 'isRestricted').mockRejectedValue(new Error('DynamoDB is unreachable'))
      const response = await handler(registrationEvent as any)
      expect(response).toStrictEqual({
        statusCode: 200,
        statusDescription: '200 OK',
        isBase64Encoded: false,
        headers: {
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(tryAgainBody())
      })
      expect(GUID.create).not.toHaveBeenCalled()
      expect(rollbar.error)
        .toHaveBeenCalledWith('registration hook Error', expect.any(Error), { lambdaEvent: registrationEvent })
    })

    it.each([
      ['fr_FR', "Nous n'avons pas pu terminer la création de votre compte. Veuillez réessayer dans quelques minutes."],
      ['pt_BR', 'Não foi possível concluir a criação da sua conta. Tente novamente em alguns minutos.'],
      ['de_DE', TRY_AGAIN_ERROR],
      ['xx_XX', TRY_AGAIN_ERROR]
    ])('should return the try again error for %s in that language, or English', async (locale, errorSummary) => {
      vi.spyOn(RestrictedDomains, 'isRestricted').mockRejectedValue(new Error('DynamoDB is unreachable'))
      const response = await handler(withLocale(locale) as any)
      expect(response.statusCode).toBe(200)
      expect(bodyOf(response)).toStrictEqual(tryAgainBody(errorSummary))
    })

    it('should deny with the try again error on any other throw', async () => {
      vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(false)
      vi.spyOn(GUID, 'create').mockImplementation(() => {
        throw new Error('Ohh noes!!')
      })
      const response = await handler(withLocale('fr_FR') as any)
      expect(response.statusCode).toBe(200)
      expect(bodyOf(response)).toStrictEqual(tryAgainBody(
        "Nous n'avons pas pu terminer la création de votre compte. Veuillez réessayer dans quelques minutes."
      ))
      expect(rollbar.error)
        .toHaveBeenCalledWith('registration hook Error', expect.any(Error), { lambdaEvent: withLocale('fr_FR') })
    })

    it('should deny with the try again error when the body is null', async () => {
      const eventWithNullBody = { ...registrationEvent, body: null }
      const response = await handler(eventWithNullBody as any)
      expect(response.statusCode).toBe(200)
      expect(bodyOf(response)).toStrictEqual(tryAgainBody())
      expect(rollbar.error).toHaveBeenCalledWith(
        'registration hook Error',
        expect.any(Error),
        { lambdaEvent: eventWithNullBody }
      )
    })

    it('should still deny when Rollbar rejects', async () => {
      vi.spyOn(RestrictedDomains, 'isRestricted').mockRejectedValue(new Error('DynamoDB is unreachable'))
      vi.mocked(rollbar.error).mockRejectedValue(new Error('Rollbar is down'))
      const response = await handler(registrationEvent as any)
      expect(response.statusCode).toBe(200)
      expect(bodyOf(response)).toStrictEqual(tryAgainBody())
    })

    it('should log one structured line for the monitor, with credentials redacted', async () => {
      // Credentials ride on SDK errors as properties (request headers, config), the
      // shape redactError strips. The message itself carries none.
      const error = Object.assign(new Error('GetItem failed'), {
        password: 'secret',
        $response: { headers: { authorization: 'AWS4-HMAC-SHA256 Credential=secret' } }
      })
      vi.spyOn(RestrictedDomains, 'isRestricted').mockRejectedValue(error)
      await handler(registrationEvent as any)

      expect(console.error).toHaveBeenCalledTimes(1)
      const line = vi.mocked(console.error).mock.calls[0][0] as string
      expect(JSON.parse(line)).toStrictEqual({ event: 'restricted_domain_check_failed', error: 'GetItem failed' })
      expect(line).not.toContain('secret')

      const reported = vi.mocked(rollbar.error).mock.calls[0][1] as unknown as typeof error
      expect(reported).toBe(error)
      expect(reported.password).toBe(REDACTED)
      expect(reported.$response.headers.authorization).toBe(REDACTED)
    })

    it('should log a thrown value that is not an Error', async () => {
      vi.spyOn(RestrictedDomains, 'isRestricted').mockRejectedValue('boom')
      const response = await handler(registrationEvent as any)
      expect(bodyOf(response)).toStrictEqual(tryAgainBody())
      expect(JSON.parse(vi.mocked(console.error).mock.calls[0][0] as string))
        .toStrictEqual({ event: 'restricted_domain_check_failed', error: 'boom' })
    })
  })

  describe('time budget', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('should answer within 1,000 ms of a failure when Rollbar never calls back', async () => {
      vi.spyOn(RestrictedDomains, 'isRestricted').mockRejectedValue(new Error('DynamoDB is unreachable'))
      vi.mocked(rollbar.error).mockReturnValue(never())
      const { state, result } = startHandler(registrationEvent)
      await vi.advanceTimersByTimeAsync(1000)
      expect(state.settled).toBe(true)
      expect(bodyOf(await result)).toStrictEqual(tryAgainBody())
    })

    it('should answer within 2,000 ms when the lookup and Rollbar both hang', async () => {
      vi.spyOn(RestrictedDomains, 'isRestricted').mockReturnValue(never())
      vi.mocked(rollbar.error).mockReturnValue(never())
      const { state, result } = startHandler(registrationEvent)
      await vi.advanceTimersByTimeAsync(2000)
      expect(state.settled).toBe(true)
      const response = await result
      expect(response.statusCode).toBe(200)
      expect(bodyOf(response)).toStrictEqual(tryAgainBody())
      expect(console.error).toHaveBeenCalledTimes(1)
      expect(JSON.parse(vi.mocked(console.error).mock.calls[0][0] as string))
        .toMatchObject({ event: 'restricted_domain_check_failed', error: expect.stringMatching(/timed out/) })
    })

    it('should still decide when a slow lookup answers inside the timeout', async () => {
      vi.spyOn(GUID, 'create').mockReturnValue(GUID_VALUE)
      vi.spyOn(RestrictedDomains, 'isRestricted')
        .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(false), 1400)))
      const { result } = startHandler(registrationEvent)
      await vi.advanceTimersByTimeAsync(1400)
      expect(bodyOf(await result).commands[0]).toStrictEqual(ALLOW)
      expect(console.error).not.toHaveBeenCalled()
    })

    it('should leave no timer pending after an allowed registration', async () => {
      vi.spyOn(GUID, 'create').mockReturnValue(GUID_VALUE)
      vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(false)
      await handler(registrationEvent as any)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('should leave no timer pending after a failure that Rollbar acknowledges', async () => {
      vi.spyOn(RestrictedDomains, 'isRestricted').mockRejectedValue(new Error('DynamoDB is unreachable'))
      vi.mocked(rollbar.error).mockResolvedValue(undefined)
      await handler(registrationEvent as any)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('every path answers 200 with an explicit decision', () => {
    it.each([
      ['an allowed domain', 'ALLOW', () => vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(false), registrationEvent],
      ['a restricted domain', 'DENY', () => vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(true), registrationEvent],
      ['a failed lookup', 'DENY', () => vi.spyOn(RestrictedDomains, 'isRestricted').mockRejectedValue(new Error('x')), registrationEvent],
      ['a GUID failure', 'DENY', () => {
        vi.spyOn(RestrictedDomains, 'isRestricted').mockResolvedValue(false)
        vi.spyOn(GUID, 'create').mockImplementation(() => { throw new Error('x') })
      }, registrationEvent],
      ['a null body', 'DENY', () => {}, { ...registrationEvent, body: null }]
    ])('%s', async (_name, decision, arrange, event) => {
      arrange()
      const response = await handler(event as any)
      expect(response.statusCode).toBe(200)
      expect(bodyOf(response).commands[0]).toStrictEqual({ type: 'com.okta.action.update', value: { registration: decision } })
    })
  })
})
