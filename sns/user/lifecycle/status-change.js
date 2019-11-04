import { Client } from '@okta/okta-sdk-nodejs'
import OktaEvent from '../../../models/okta-event'
import rollbar from '../../../config/rollbar'
import GlobalRegistry from '../../../models/global-registry'

export const handler = async (lambdaEvent) => {
  const okta = new Client()
  const globalRegistry = new GlobalRegistry(process.env.GLOBAL_REGISTRY_TOKEN, process.env.GLOBAL_REGISTRY_URL)
  try {
    const event = new OktaEvent(lambdaEvent.Records[0].Sns.Message)
    const user = await okta.getUser(event.userId)
    let updateProfile = false
    switch (user.status) {
      case 'ACTIVE':
        updateProfile = await globalRegistry.createOrUpdateProfile(user.profile)
        break
      case 'DEPROVISIONED':
        updateProfile = await globalRegistry.deleteProfile(user.profile)
        break
    }

    if (updateProfile) {
      await user.update()
    }
  } catch (error) {
    await rollbar.error('user.lifecycle.create Error', error, { lambdaEvent })
    throw error
  }
}
