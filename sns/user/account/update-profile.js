import { Client } from '@okta/okta-sdk-nodejs'
import rollbar from '../../../config/rollbar'
import OktaEvent from '../../../models/okta-event'
import GlobalRegistry from '../../../models/global-registry'

export const handler = async (lambdaEvent) => {
  const okta = new Client({ cacheMiddleware: null })
  const globalRegistry = new GlobalRegistry(process.env.GLOBAL_REGISTRY_TOKEN, process.env.GLOBAL_REGISTRY_URL)
  try {
    const request = new OktaEvent(lambdaEvent.Records[0].Sns.Message)
    const user = await okta.userApi.getUser({userId: request.userId})
    let hasUpdate = false

    // If login changed, and it doesn't match email, set email to the value of login and mark for update
    if (request.changedAttributes.includes('login')) {
      if (user.profile.login !== user.profile.email) {
        user.profile.email = user.profile.login
        hasUpdate = true
      }
    }

    // If theKeyGuid is set and something changed, update Global Registry, mark for update if GR changed profile
    if (user.profile.theKeyGuid && user.status !== 'DEPROVISIONED' && request.changedAttributes.length > 0) {
      if (await globalRegistry.createOrUpdateProfile(user.profile)) {
        hasUpdate = true
      }
    }

    // Fire user update if marked for update
    if (hasUpdate) {
      await user.update()
    }
  } catch (error) {
    await rollbar.error('user.account.update_profile Error', error, { lambdaEvent })
    throw error
  }
}
