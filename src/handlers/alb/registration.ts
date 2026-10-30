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

// Set by a per-policy inline hook URI (e.g. `/registration?locale=fr_FR`) so Okta
// sends the activation email in that language. Without it, behaviour is unchanged.
const ALLOWED_LOCALES = new Set(['fr_FR'])

export const handler = async (lambdaEvent: ALBEvent): Promise<ALBResult> => {
  try {
    const response = new HookResponse()
    const registration = new RegistrationRequest(lambdaEvent.body ?? '')
    const requestedLocale = lambdaEvent.queryStringParameters?.locale
    const locale = requestedLocale && ALLOWED_LOCALES.has(requestedLocale) ? requestedLocale : undefined
    if (await RestrictedDomains.isRestricted(registration.login)) {
      response.addCommand(COMMAND_ACTION_UPDATE, { registration: 'DENY' })
      response.addError({
        errorSummary: locale === 'fr_FR'
          ? "Veuillez contacter help@checkmyokta.com avant d'utiliser ce domaine de messagerie."
          : 'help@checkmyokta.com must be contacted before this email domain can be used.',
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
