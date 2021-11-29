import { Client } from '@okta/okta-sdk-nodejs'
import OktaEvent from '../../../models/okta-event'
import rollbar from '../../../config/rollbar'
import GlobalRegistry from '../../../models/global-registry'

export const handler = async (lambdaEvent) => {
  const okta = new Client({ cacheMiddleware: null })
  const globalRegistry = new GlobalRegistry(process.env.GLOBAL_REGISTRY_TOKEN, process.env.GLOBAL_REGISTRY_URL)
  try {
    const event = new OktaEvent(lambdaEvent.Records[0].Sns.Message)
    const user = await okta.getUser(event.userId)
    switch (user.status) {
      case 'ACTIVE':
        if (await globalRegistry.createOrUpdateProfile(user.profile)) {
          await user.update()
        }
        break
      case 'DEPROVISIONED':
        await globalRegistry.deleteProfile(user.profile)
        break
    }
  } catch (error) {
    await rollbar.error('status-change Error', error, { lambdaEvent })
    throw error
  }
}
