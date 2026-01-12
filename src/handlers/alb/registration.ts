import type { ALBEvent, ALBResult } from 'aws-lambda'
import HookResponse, {
  COMMAND_ACTION_UPDATE,
  COMMAND_USER_PROFILE_UPDATE
} from '../../models/hook-response.js'
import GUID from '../../models/guid.js'
import rollbar from '../../config/rollbar.js'
import RestrictedDomains from '../../models/restricted-domains.js'
import RegistrationRequest from '../../models/registration-request.js'

export const handler = async (lambdaEvent: ALBEvent): Promise<ALBResult> => {
  try {
    const response = new HookResponse()
    const registration = new RegistrationRequest(lambdaEvent.body ?? '')
    if (await RestrictedDomains.isRestricted(registration.login)) {
      response.addCommand(COMMAND_ACTION_UPDATE, { registration: 'DENY' })
      response.addError({
        errorSummary: 'help@checkmyokta.com must be contacted before this email domain can be used.',
        reason: 'RESTRICTED_EMAIL_DOMAIN',
        location: 'data.userProfile.login'
      })
    } else {
      response.addCommand(COMMAND_USER_PROFILE_UPDATE, {
        theKeyGuid: GUID.create(),
        orca: false // Set ORCA to false on self-service registration
      })
    }
    return response.toALBResponse()
  } catch (error) {
    // Log error to rollbar
    await rollbar.error('registration hook Error', error as Error, { lambdaEvent })
    // Return success to okta, `user.lifecycle.create` event hook will add a GUID if necessary
    return new HookResponse({ statusCode: 204 }).toALBResponse()
  }
}
