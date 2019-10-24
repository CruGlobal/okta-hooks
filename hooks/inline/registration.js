import HookResponse, { COMMAND_USER_PROFILE_UPDATE } from '../../models/hook-response'
import GUID from '../../models/guid'
import rollbar from '../../config/rollbar'

export const handler = async (lambdaEvent) => {
  try {
    const response = new HookResponse()
    response.addCommand(COMMAND_USER_PROFILE_UPDATE, {
      theKeyGuid: GUID.create()
    })
    return response.toALBResponse()
  } catch (error) {
    // Log error to rollbar
    rollbar.error('registration hook Error', error, { lambdaEvent })
    // Return success to okta, `user.lifecycle.create` event hook will add a GUID if necessary
    return new HookResponse({ statusCode: 204 }).toALBResponse()
  }
}
