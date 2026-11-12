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
// sends the activation email in that language, each with the blocked-domain error
// in that language. Any other value, or no header, leaves the response unchanged.
const RESTRICTED_DOMAIN_ERRORS = new Map([
  ['fr_FR', "Veuillez contacter help@checkmyokta.com avant d'utiliser ce domaine de messagerie."],
  ['pt_BR', 'Entre em contato com help@checkmyokta.com antes de usar este domínio de e-mail.']
])
const DEFAULT_RESTRICTED_DOMAIN_ERROR = 'help@checkmyokta.com must be contacted before this email domain can be used.'

export const handler = async (lambdaEvent: ALBEvent): Promise<ALBResult> => {
  try {
    const response = new HookResponse()
    const registration = new RegistrationRequest(lambdaEvent.body ?? '')
    const requestedLocale = lambdaEvent.headers?.['x-cru-locale']
    const localizedError = requestedLocale ? RESTRICTED_DOMAIN_ERRORS.get(requestedLocale) : undefined
    const locale = localizedError ? requestedLocale : undefined
    if (await RestrictedDomains.isRestricted(registration.login)) {
      response.addCommand(COMMAND_ACTION_UPDATE, { registration: 'DENY' })
      response.addError({
        errorSummary: localizedError ?? DEFAULT_RESTRICTED_DOMAIN_ERROR,
        reason: 'RESTRICTED_EMAIL_DOMAIN',
        location: 'data.userProfile.login'
      })
    } else {
      const profile: Record<string, unknown> = {
        theKeyGuid: GUID.create(),
        orca: false // Set ORCA to false on self-service registration
      }
      if (locale) profile.locale = locale
      response.addCommand(COMMAND_USER_PROFILE_UPDATE, profile)
    }
    return response.toALBResponse()
  } catch (error) {
    // Log error to rollbar
    // Strip credentials before anything serialises this error: the rethrow below
    // reaches the Lambda runtime's log line, which the Datadog extension ships.
    await rollbar.error('registration hook Error', redactError(error) as Error, { lambdaEvent })
    // Return success to okta, `user.lifecycle.create` event hook will add a GUID if necessary
    return new HookResponse({ statusCode: 204 }).toALBResponse()
  }
}
