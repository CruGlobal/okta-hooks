import { Client } from '@okta/okta-sdk-nodejs'
import OktaEvent from '../../../models/okta-event'
import rollbar from '../../../config/rollbar'
import GUID from '../../../models/guid'
import GlobalRegistry from '../../../models/global-registry'

export const handler = async (lambdaEvent) => {
  const okta = new Client()
  const globalRegistry = new GlobalRegistry(process.env.GLOBAL_REGISTRY_TOKEN, process.env.GLOBAL_REGISTRY_URL)
  try {
    const request = new OktaEvent(lambdaEvent.Records[0].Sns.Message)
    const user = await okta.getUser(request.userId)
    if (typeof user.profile.theKeyGuid === 'undefined') {
      user.profile.theKeyGuid = GUID.create()
    }
    await globalRegistry.createOrUpdateProfile(user.profile)
    await user.update()
  } catch (error) {
    await rollbar.error('user.lifecycle.create Error', error, { lambdaEvent })
    throw error
  }
}
