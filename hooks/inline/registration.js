import HookResponse, { COMMAND_ACTION_UPDATE, COMMAND_USER_PROFILE_UPDATE } from '../../models/hook-response'
import GUID from '../../models/guid'
import rollbar from '../../config/rollbar'
import RestrictedDomains from '../../models/restricted-domains'
import RegistrationRequest from '../../models/registration-request'

export const handler = async (lambdaEvent) => {
  try {
    const response = new HookResponse()
    const registration = new RegistrationRequest(lambdaEvent.body)
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
        notes: "Users who have a Staged or Provisioned status (are not yet Active) and have ORCA=F, should not see the Set Up Optional Security Methods screen during the Welcome Wizard." // An Okta Rule will look for this Note (added only once and during SSR) and take appropriate action. Once the account is Active, an Okta Workflow will remove the Note.
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
