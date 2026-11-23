import type { ALBEvent, ALBResult } from 'aws-lambda'
import HookResponse, {
  COMMAND_ACTION_UPDATE,
  COMMAND_USER_PROFILE_UPDATE
} from '../../models/hook-response.js'
import GUID from '../../models/guid.js'
import rollbar from '../../config/rollbar.js'
import RestrictedDomains from '../../models/restricted-domains.js'
import RegistrationRequest from '../../models/registration-request.js'
import redactError from '../../utils/redact-error.js'

// Locales a per-policy inline hook may send in its `X-Cru-Locale` header so Okta
// sends the activation email in that language: each is in a non-English language Okta
// translates emails into. Any other value, or no header, leaves the response unchanged.
const ALLOWED_LOCALES = new Set([
  'cs_CZ', 'da_DK', 'de_DE', 'el_GR', 'es_ES', 'es_MX', 'es_PR', 'fi_FI', 'fr_FR',
  'ht_HT', 'hu_HU', 'id_ID', 'it_IT', 'ja_JP', 'ko_KR', 'ms_MY', 'nb_NO', 'nl_NL',
  'pl_PL', 'pt_BR', 'ro_RO', 'ru_RU', 'sv_SE', 'th_TH', 'tr_TR', 'uk_UA', 'vi_VN',
  'zh_CN', 'zh_TW'
])
// Blocked-domain errors translated so far. An allowed locale without one gets English.
// The fr_FR texts come from a native speaker. The pt_BR texts still need a native
// speaker's check.
const RESTRICTED_DOMAIN_ERRORS = new Map([
  ['fr_FR', 'Veuillez contacter help@checkmyokta.com avant de créer un compte avec cette adresse e-mail.'],
  ['pt_BR', 'Entre em contato com help@checkmyokta.com antes de usar este domínio de e-mail.']
])
const DEFAULT_RESTRICTED_DOMAIN_ERROR = 'help@checkmyokta.com must be contacted before this email domain can be used.'
// Shown when the check could not run, so the sign-up is refused. Translated for the
// same locales as the blocked-domain errors; any other locale gets English.
const CHECK_UNAVAILABLE_ERRORS = new Map([
  ['fr_FR', "Nous n'avons pas pu terminer la création de votre compte. Veuillez réessayer dans quelques minutes. Si le problème persiste, contactez help@checkmyokta.com."],
  ['pt_BR', 'Não foi possível concluir a criação da sua conta. Tente novamente em alguns minutos. Se o problema persistir, entre em contato com help@checkmyokta.com.']
])
const DEFAULT_CHECK_UNAVAILABLE_ERROR = "We couldn't finish creating your account. Please try again in a few minutes. If the problem continues, contact help@checkmyokta.com."

// Okta waits at most 3 s for this hook, then refuses the sign-up with its own generic
// error. The lookup gets 1.5 s and the Rollbar report at most 0.5 s, so the hook
// answers in about 2 s even when DynamoDB and Rollbar both hang. Exported for the
// time budget tests.
export const CHECK_TIMEOUT_MS = 1500
export const ROLLBAR_WAIT_MS = 500

const allowedLocale = (requestedLocale: string | undefined): string | undefined =>
  requestedLocale && ALLOWED_LOCALES.has(requestedLocale) ? requestedLocale : undefined

// Settles like `promise`, or rejects once `ms` has passed. The timer is cleared
// either way, so a quick answer leaves nothing pending.
const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Restricted domain check timed out after ${ms} ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Waits for `promise` for at most `ms`, and never throws: reporting a failure must
// not stop the hook from answering.
const waitAtMost = async (promise: Promise<unknown>, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms) })])
  } catch {
    /* the report failed; the answer still goes out */
  } finally {
    clearTimeout(timer)
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const errorName = (error: unknown): string | undefined => (error instanceof Error ? error.name : undefined)

const checkUnavailableResponse = (locale: string | undefined): ALBResult => {
  const response = new HookResponse()
  response.addCommand(COMMAND_ACTION_UPDATE, { registration: 'DENY' })
  response.addError({
    errorSummary: (locale && CHECK_UNAVAILABLE_ERRORS.get(locale)) ?? DEFAULT_CHECK_UNAVAILABLE_ERROR,
    reason: 'RESTRICTED_DOMAIN_CHECK_UNAVAILABLE',
    location: 'data.userProfile.login'
  })
  return response.toALBResponse()
}

// Always answers HTTP 200 with an explicit ALLOW or DENY.
export const handler = async (lambdaEvent: ALBEvent): Promise<ALBResult> => {
  try {
    const response = new HookResponse()
    const registration = new RegistrationRequest(lambdaEvent.body ?? '')
    const locale = allowedLocale(lambdaEvent.headers?.['x-cru-locale'])
    if (await withTimeout(RestrictedDomains.isRestricted(registration.login), CHECK_TIMEOUT_MS)) {
      response.addCommand(COMMAND_ACTION_UPDATE, { registration: 'DENY' })
      response.addError({
        errorSummary: (locale && RESTRICTED_DOMAIN_ERRORS.get(locale)) ?? DEFAULT_RESTRICTED_DOMAIN_ERROR,
        reason: 'RESTRICTED_EMAIL_DOMAIN',
        location: 'data.userProfile.login'
      })
    } else {
      response.addCommand(COMMAND_ACTION_UPDATE, { registration: 'ALLOW' })
      const profile: Record<string, unknown> = {
        theKeyGuid: GUID.create(),
        orca: false // Set ORCA to false on self-service registration
      }
      if (locale) profile.locale = locale
      response.addCommand(COMMAND_USER_PROFILE_UPDATE, profile)
    }
    return response.toALBResponse()
  } catch (error) {
    // Any failure refuses the sign-up with a "try again" error rather than let it
    // through unchecked. The log line feeds the Datadog monitor, and the error name
    // (an AWS SDK exception name, for example) tells the failures apart. Credentials
    // are stripped first, before the log line or Rollbar serialises the error.
    const redacted = redactError(error)
    console.error(JSON.stringify({
      event: 'restricted_domain_check_failed',
      name: errorName(redacted),
      error: errorMessage(redacted)
    }))
    // The Rollbar wrapper resolves only on Rollbar's callback, which may never come.
    await waitAtMost(rollbar.error('registration hook Error', redacted as Error, { lambdaEvent }), ROLLBAR_WAIT_MS)
    return checkUnavailableResponse(allowedLocale(lambdaEvent?.headers?.['x-cru-locale']))
  }
}
