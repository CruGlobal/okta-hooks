import { Client } from '@okta/okta-sdk-nodejs'
import rollbar from '../../../config/rollbar'
import OktaEvent from '../../../models/okta-event'
import GlobalRegistry from '../../../models/global-registry'

export const handler = async (lambdaEvent) => {
  const okta = new Client()
  const globalRegistry = new GlobalRegistry(process.env.GLOBAL_REGISTRY_TOKEN, process.env.GLOBAL_REGISTRY_URL)
  try {
    const request = new OktaEvent(lambdaEvent.Records[0].Sns.Message)
    const user = await okta.getUser(request.userId)
    let hasUpdate = false
    if (request.changedAttributes.includes('login')) {
      // If login changed, and it doesn't match email, set email to the value of login
      if (user.profile.login !== user.profile.email) {
        user.profile.email = user.profile.login
        hasUpdate = true
      }
    }

    if (user.profile.theKeyGuid && request.changedAttributes.length > 0) {
      // If theKeyGuid is set and something changed, update Global Registry
      if (await globalRegistry.updateProfile(user.profile)) {
        hasUpdate = true
      }
    }

    if (hasUpdate) {
      await user.update()
    }
  } catch (error) {
    await rollbar.error('user.account.update_profile Error', error, { lambdaEvent })
    throw error
  }
}
