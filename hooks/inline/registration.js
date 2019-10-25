import HookResponse, { COMMAND_ACTION_UPDATE, COMMAND_USER_PROFILE_UPDATE } from '../../models/hook-response'
import GUID from '../../models/guid'
import rollbar from '../../config/rollbar'
import RestrictedDomain from '../../models/restricted-domain'
import RegistrationRequest from '../../models/registration-request'

export const handler = async (lambdaEvent) => {
  try {
    const response = new HookResponse()
    const registration = new RegistrationRequest(lambdaEvent.body)
    if (await RestrictedDomain.isRestricted(registration.email)) {
      response.addCommand(COMMAND_ACTION_UPDATE, { registration: 'DENY' })
      response.addError({
        errorSummary: 'You specified a restricted email domain. Please contact <a href="mailto:help@cru.org">help@cru.org</a> to set-up this account.',
        reason: 'RESTRICTED_EMAIL_DOMAIN',
        location: 'data.userProfile.email'
      })
    } else {
      response.addCommand(COMMAND_USER_PROFILE_UPDATE, {
        theKeyGuid: GUID.create()
      })
    }
    return response.toALBResponse()
  } catch (error) {
    // Log error to rollbar
    await rollbar.error('registration hook Error', error, { lambdaEvent })
    // Return success to okta, `user.lifecycle.create` event hook will add a GUID if necessary
    return new HookResponse({ statusCode: 204 }).toALBResponse()
  }
}
